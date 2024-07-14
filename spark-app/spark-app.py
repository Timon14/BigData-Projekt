from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import IntegerType, StringType, StructType, TimestampType
import threading
import time

dbUrl = 'jdbc:mysql://my-app-mariadb-service:3306/popular'
dbOptions = {"user": "root", "password": "mysecretpw"}
dbDetailedTable = 'detailed_tracking'
dbPopularTable = 'popular'

# Create a spark session
spark = SparkSession.builder \
    .appName("Kafka to MariaDB") \
    .getOrCreate()

# Set log level
spark.sparkContext.setLogLevel('WARN')

# Define schema of tracking data
trackingMessageSchema = StructType() \
    .add("action", StringType()) \
    .add("productId", IntegerType()) \
    .add("email", StringType()) \
    .add("timestamp", IntegerType())

# Read messages from Kafka
kafkaMessages = spark \
    .readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "my-cluster-kafka-bootstrap:9092") \
    .option("subscribe", "tracking-data") \
    .option("startingOffsets", "earliest") \
    .load()

# Convert value: binary -> JSON -> fields + parsed timestamp
trackingMessages = kafkaMessages.select(
    from_json(column("value").cast("string"), trackingMessageSchema).alias("json")
).select(
    from_unixtime(column('json.timestamp')).cast(TimestampType()).alias("parsed_timestamp"),
    column("json.productId").alias("productId"),
    column("json.email").alias("email")
)

# Function to save detailed tracking data to database
def saveDetailedTrackingToDatabase(batchDataframe, batchId):
    global dbUrl, dbDetailedTable, dbOptions
    print(f"Writing detailed tracking data batchID {batchId} to database @ {dbUrl}")
    batchDataframe \
        .selectExpr(
            "CAST(parsed_timestamp AS TIMESTAMP) AS timestamp",
            "CAST(productId AS INT) AS productId",
            "email"
        ) \
        .write \
        .jdbc(dbUrl, dbDetailedTable, mode="append", properties=dbOptions)

# Write detailed tracking data to database
detailedTrackingInsertStream = trackingMessages \
    .writeStream \
    .outputMode("append") \
    .foreachBatch(saveDetailedTrackingToDatabase) \
    .start()

# Compute most popular products 
popular = trackingMessages.withColumn(
    "count", lit(1)
).groupBy(
    column("productId")
).agg(
    sum("count").alias("count")
) \
 .withColumnRenamed('productId', 'productID') \
 .select('productID', 'count') \
 .orderBy(col('count').desc())

# Function to save popular products data to database
def savePopularToDatabase(batchDataframe, batchId):
    global dbUrl, dbPopularTable, dbOptions
    print(f"Writing popular products data batchID {batchId} to database @ {dbUrl}")
    batchDataframe \
        .write \
        .jdbc(dbUrl, dbPopularTable, mode="overwrite", properties=dbOptions)

# Write popular products data to database
popularInsertStream = popular \
    .writeStream \
    .outputMode("complete") \
    .foreachBatch(savePopularToDatabase) \
    .start()


# Start running the query; print running counts to the console
consoleDump = trackingMessages \
    .writeStream \
    .outputMode("append") \
    .format("console") \
    .start()

# Function to read and print the database contents periodically
def printDatabaseContents():
    while True:
        df = spark.read.jdbc(url=dbUrl, table=dbPopularTable, properties=dbOptions)
        df.show(truncate=False)
        time.sleep(10)  # Sleep for 10 seconds

# Start the database contents print function in a separate thread
printDbThread = threading.Thread(target=printDatabaseContents)
printDbThread.setDaemon(True)
printDbThread.start()

# Wait for termination
spark.streams.awaitAnyTermination()
