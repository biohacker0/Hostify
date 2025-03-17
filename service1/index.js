const express = require("express");
const cors = require("cors");
const amqp = require("amqplib");
const app = express();
import { createClient } from "redis";
import { $, randomUUIDv7 } from "bun";
const path = require("path");

import dotenv from "dotenv";
dotenv.config();

const LOGS_ENABLED = process.env.LOGS_ENABLED !== "false";

function log(...args) {
  if (LOGS_ENABLED) {
    console.log(...args);
  }
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const port = process.env.PORT || 3000;
let queue = "bridge_queue";
const rabbitMqUrl = process.env.RABBIT_MQ_URL;

const redisIp = process.env.REDIS_IP;
const redisPort = process.env.REDIS_PORT;
const redisPassword = process.env.REDIS_PASSWORD;
log("redis-ip", redisIp);
log("redis-port:", redisPort);
log("redis pass:", redisPassword);

const redisURI = `redis://default:${redisPassword}@${redisIp}:${redisPort}`;
log("redis url:", redisURI);

// host url
const service1HostIP = process.env.SERVICE1_IP;
log("service 1:", service1HostIP);

// Create a single connection to RabbitMQ
let connection;
let channel;
let redisClient;
//redis

const DeploymentEnum = {
  processing: "processing",
  cloned: "repo cloned sucessefully",
  build: "repo built sucessfully",
  deployed: "repo deployed sucessfully",
  failed: "deployment failed please retry again",
};

// Establish connection on startup
async function setupRabbitMQAndRedis() {
  let retries = 5;
  let connected = false;

  while (!connected && retries > 0) {
    try {
      log(`Attempting to connect to RabbitMQ (${retries} attempts left)...`);
      connection = await amqp.connect(rabbitMqUrl);
      channel = await connection.createChannel();
      await channel.assertQueue(queue, { durable: false });
      log("Connected to RabbitMQ");

      log(`Attempting to connect to Redis (${retries} attempts left)...`);
      redisClient = createClient({
        url: redisURI,
      });

      await redisClient.connect();
      log("Connected to Redis");
      connected = true;
    } catch (error) {
      console.error(`Connection attempt failed (${retries} retries left):`, error);
      retries--;
      // Wait 5 seconds before retrying
      log("Waiting 5 seconds before retrying...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  if (!connected) {
    console.error("Failed to connect to RabbitMQ or Redis after multiple attempts");
    process.exit(1);
  }
}

app.post("/url", async (req, res) => {
  try {
    log("Received URL:", req.body.url);
    let github_url = req.body.url;

    if (!channel) {
      return res.status(500).json({ error: "RabbitMQ connection not established" });
    }

    const userTrackId = randomUUIDv7();
    const userTrackingUrl = `http://${service1HostIP}:${port}/checkDeployment/${userTrackId}`;

    await redisClient.set(userTrackId, JSON.stringify({ github_url: github_url, deployment_status: DeploymentEnum.processing, deployedUrl: null }));
    channel.sendToQueue(queue, Buffer.from(userTrackId));
    log(" [x] Sent %s", userTrackId);

    res.json({ msg: "url queued for processing", userTrackingUrl: userTrackingUrl });
  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).json({ error: "Failed to process URL" });
  }
});

app.get("/checkDeployment/:userTrackId", async function (req, res) {
  try {
    let userTrackId = req.params.userTrackId;
    log(userTrackId);
    let deployemntStatusObject = await redisClient.get(userTrackId);
    let parsed_deployemntStatusObject = JSON.parse(deployemntStatusObject);

    if (parsed_deployemntStatusObject.deployment_status == DeploymentEnum.deployed) {
      // res.json({ msg: parsed_deployemntStatusObject.deployedUrl });
      res.json({ msg: parsed_deployemntStatusObject.deployment_status, redirectUrl: parsed_deployemntStatusObject.deployedUrl });
    } else {
      res.json({ msg: parsed_deployemntStatusObject.deployment_status, redirectUrl: "still processing" });
    }
  } catch (error) {
    console.log(error);
  }
});

// Handle graceful shutdown
process.on("SIGINT", async () => {
  try {
    if (channel) await channel.close();
    if (connection) await connection.close();
    log("RabbitMQ connection closed");
  } catch (error) {
    console.error("Error closing RabbitMQ connection:", error);
  }
  process.exit(0);
});

// Start the server after connecting to RabbitMQ
setupRabbitMQAndRedis()
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      log(`Example app listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to start server:", err);
  });
