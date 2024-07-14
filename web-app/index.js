const os = require('os');
const dns = require('dns').promises;
const { program: optionparser } = require('commander');
const { Kafka } = require('kafkajs');
const mariadb = require('mariadb');
const MemcachePlus = require('memcache-plus');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();
const cacheTimeSecs = 15;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));
app.use(session({
    secret: 'dein-geheimer-schluessel-1234567890', 
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } 
}));

// -------------------------------------------------------
// Command-line options (with sensible defaults)
// -------------------------------------------------------

let options = optionparser
    .storeOptionsAsProperties(true)
    // Web server
    .option('--port <port>', "Web server port", 3000)
    // Kafka options
    .option('--kafka-broker <host:port>', "Kafka bootstrap host:port", "my-cluster-kafka-bootstrap:9092")
    .option('--kafka-topic-tracking <topic>', "Kafka topic to tracking data send to", "tracking-data")
    .option('--kafka-client-id <id>', "Kafka client ID", "tracker-" + Math.floor(Math.random() * 100000))
    // Memcached options
    .option('--memcached-hostname <hostname>', 'Memcached hostname (may resolve to multiple IPs)', 'my-memcached-service')
    .option('--memcached-port <port>', 'Memcached port', 11211)
    .option('--memcached-update-interval <ms>', 'Interval to query DNS for memcached IPs', 5000)
	// Database options
    .option('--mariadb-host <host>', 'MariaDB host', 'my-app-mariadb-service')
    .option('--mariadb-port <port>', 'MariaDB port', 3306)
    .option('--mariadb-schema <db>', 'MariaDB Schema/database', 'popular')
    .option('--mariadb-username <username>', 'MariaDB username', 'root')
    .option('--mariadb-password <password>', 'MariaDB password', 'mysecretpw')
    // Misc
    .addHelpCommand()
    .parse()
    .opts();

// -------------------------------------------------------
// Database Configuration
// -------------------------------------------------------

const pool = mariadb.createPool({
    host: options.mariadbHost,
    port: options.mariadbPort,
    database: options.mariadbSchema,
    user: options.mariadbUsername,
    password: options.mariadbPassword,
    connectionLimit: 5
});

async function executeQuery(query, params) {
    let connection;
    try {
        connection = await pool.getConnection();
        console.log("Executing query:", query, "with params:", params);
        let res = await connection.query(query, params);
        return res;
    } finally {
        if (connection)
            connection.end();
    }
}

// -------------------------------------------------------
// Memcache Configuration
// -------------------------------------------------------

//Connect to the memcached instances
let memcached = null;
let memcachedServers = [];

async function getMemcachedServersFromDns() {
    try {
        // Query all IP addresses for this hostname
        let queryResult = await dns.lookup(options.memcachedHostname, { all: true });

        // Create IP:Port mappings
        let servers = queryResult.map(el => el.address + ":" + options.memcachedPort);

        // Check if the list of servers has changed
		// and only create a new object if the server list has changed
        if (memcachedServers.sort().toString() !== servers.sort().toString()) {
            console.log("Updated memcached server list to ", servers);
            memcachedServers = servers;
            
            //Disconnect an existing client
            if (memcached)
                await memcached.disconnect();

            memcached = new MemcachePlus(memcachedServers);
        }
    } catch (e) {
        console.log("Unable to get memcache servers (yet)");
    }
}

//Initially try to connect to the memcached servers, then each 5s update the list
getMemcachedServersFromDns();
setInterval(() => getMemcachedServersFromDns(), options.memcachedUpdateInterval);

//Get data from cache if a cache exists yet
async function getFromCache(key) {
    if (!memcached) {
        console.log(`No memcached instance available, memcachedServers = ${memcachedServers}`);
        return null;
    }
    return await memcached.get(key);
}

// -------------------------------------------------------
// Kafka Configuration
// -------------------------------------------------------

// Kafka connection
const kafka = new Kafka({
    clientId: options.kafkaClientId,
    brokers: [options.kafkaBroker],
    retry: {
        retries: 0
    }
});

const producer = kafka.producer();

// Send tracking message to Kafka
async function sendTrackingMessage(data) {
    //Ensure the producer is connected
    await producer.connect();

    //Send message
    let result = await producer.send({
        topic: options.kafkaTopicTracking,
        messages: [
            { value: JSON.stringify(data) }
        ]
    });

    console.log("Send result:", {
        topicName: options.kafkaTopicTracking,
        ProductID: data.productId,
        email: data.email
    });
    return result;
}


function sendResponse(res, products, cachedResult) {
    const productHTML = products.map(product => `
        <li class="product-item">
            <div class="product">
                <img src="${product.image_url}" alt="${product.name}">
                <h2>${product.name}</h2>
                <p>${product.description}</p>
                <p>$${parseFloat(product.price).toFixed(2)}</p>
                <button onclick="addToCart(${product.productID})">Add to Cart</button>
            </div>
        </li>
    `).join('');

    const fs = require('fs');
    const path = require('path');
    const htmlFilePath = path.join(__dirname, 'page.html');
    
    fs.readFile(htmlFilePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading HTML file:', err);
            res.status(500).send('Error reading HTML file');
            return;
        }
    
        // Replace the placeholder with the generated product HTML
        const modifiedData = data.replace('<!-- PRODUCTS_PLACEHOLDER -->', productHTML);

        // Send the modified HTML as the response
        res.send(modifiedData);
    });
}

// Get Products 
async function getProducts() {
    const cacheKey = 'products';
    let products = await getFromCache(cacheKey);

    if (!products) {
        console.log("Cache miss, querying database...");
        const query = 'SELECT * FROM products';
        const result = await executeQuery(query);

        products = result.map(row => ({
            productID: row.productID,
            name: row.name,
            description: row.description,
            price: row.price,
            image_url: row.image_url
        }));

        if (memcached) {
            await memcached.set(cacheKey, products, cacheTimeSecs);
        }
    } else {
        console.log("Cache hit");
    }

    return products;
}

// -------------------------------------------------------
// Start page
// -------------------------------------------------------

// Fetches and sends a list of products
app.get("/", async (req, res) => {
    try {
        const products = await getProducts();
        sendResponse(res, products, false);
    } catch (error) {
        res.status(500).send("Error retrieving products");
        console.error(error);
    }
});

// Sends a tracking message with action, product ID, email, and timestamp
app.post("/track", (req, res) => {
    const { action, productId, email } = req.body;
    sendTrackingMessage({ action, productId, email, timestamp: Math.floor(new Date() / 1000) })
        .then(result => res.json({ success: true, result }))
        .catch(error => res.status(500).json({ success: false, error: error.message }));
});

// Authenticates user by checking email and password, stores session info
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const query = 'SELECT password_hash FROM users WHERE email = ?';
        console.log(`Executing query: ${query} with params: ${email}`);
        const result = await executeQuery(query, [email]);
        console.log('Query result:', result);
        
        if (result.length > 0) {
            const passwordHash = result[0].password_hash;
            console.log('Password hash from DB:', passwordHash);
            const isValid = await bcrypt.compare(password, passwordHash);
            console.log('Password validation result:', isValid);
            
            // store user info in session
            if (isValid) {
                req.session.user = { email }; 
                res.json({ success: true });
            } else {
                res.json({ success: false, message: 'Invalid email or password' });
            }
        } else {
            res.json({ success: false, message: 'Invalid email or password' });
        }
    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Destroys the session and redirects to the homepage
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).send('Logout failed');
        }
        res.redirect('/');
    });
});

// cks if a user is logged in and returns their email if they are
app.get('/check-login', (req, res) => {
    if (req.session.user) {
        res.json({ loggedIn: true, email: req.session.user.email });
    } else {
        res.json({ loggedIn: false });
    }
});

// Retrieves the most recent 3 products the user interacted with if logged in
app.get('/cart-products', async (req, res) => {
    if (!req.session.user) {
        return res.json({ loggedIn: false });
    }
    
    const email = req.session.user.email;
    try {
        const query = `
        SELECT p.*
        FROM (
            SELECT dt.productID, MAX(dt.timestamp) AS latest_timestamp
            FROM detailed_tracking dt
            WHERE dt.email = ?
            GROUP BY dt.productID
            ORDER BY latest_timestamp DESC
            LIMIT 3
        ) recent_interactions
        JOIN products p ON recent_interactions.productID = p.productID
        ORDER BY recent_interactions.latest_timestamp DESC; 
        `;
        const result = await executeQuery(query, [email]);

        if (result.length > 0) {
            const products = result.map(row => ({
                productID: row.productID,
                name: row.name,
                description: row.description,
                price: row.price,
                image_url: row.image_url
            }));
            res.json({ loggedIn: true, products });
        } else {
            res.json({ loggedIn: true, products: [] });
        }
    } catch (error) {
        console.error('Error retrieving cart products:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Retrieves and sends the top 3 most viewed products
app.get('/most-viewed-products', async (req, res) => {
    try {
        const query = `SELECT p.*
         FROM products p 
         JOIN popular pop 
         ON p.productID = pop.productID 
         LIMIT 3`;
        const result = await executeQuery(query);

        const products = result.map(row => ({
            productID: row.productID,
            name: row.name,
            description: row.description,
            price: row.price,
            image_url: row.image_url
        }));

        res.json({ success: true, products });
    } catch (error) {
        console.error('Error retrieving most viewed products:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// -------------------------------------------------------
// Main method
// -------------------------------------------------------

app.listen(options.port, function () {
    console.log("Node app is running at http://localhost:" + options.port);
});
