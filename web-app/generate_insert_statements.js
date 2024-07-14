const loremIpsum = require("lorem-ipsum").loremIpsum;

const numberOfProducts = 4;

const sqls = Array.from(Array(numberOfProducts).keys())
    .map(productId => {
        const heading = loremIpsum({ count: 1, units: "sentence" }).replace(/[\r\n]+/g, "");
        const description = loremIpsum({ count: 5, units: "paragraphs" }).replace(/[\r\n]+/g, "\\n");

        return `INSERT INTO products (product_id, description, heading) VALUES (${productId}, '${description.replace(/'/g, "''")}', '${heading.replace(/'/g, "''")}');`
    })
    .join("\n");

console.log(sqls);
