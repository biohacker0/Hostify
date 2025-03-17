const express = require("express");
const cors = require("cors");
const amqp = require("amqplib");
const app = express();
import { mkdir } from "node:fs/promises";
import { join } from "path";
import { $, randomUUIDv7 } from "bun";
import { promises as fs } from "fs";
import { rm } from "fs/promises";
import { createClient } from "redis";
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

const port = process.env.PORT || 3001;
const rabbitMqUrl = process.env.RABBIT_MQ_URL;

const redisIp = process.env.REDIS_IP;
const redisPort = process.env.REDIS_PORT;

log("redis-ip", redisIp);
log("redis-port:", redisPort);

const redisPassword = process.env.REDIS_PASSWORD;
log("redis pass:", redisPassword);
const redisURI = `redis://default:${redisPassword}@${redisIp}:${redisPort}`;
log("redis url:", redisURI);

const S3_End_Point = process.env.S3_ENDPOINT;
//nw3.digitaloceanspaces.com
const S3_Bucket_Name = process.env.S3_BUCKET_NAME;
//bucker name
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
//3QJ5QZQZQZQZQZQZQZQZ
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
//2dsadasJfdsfdsBfdsfuji21HNHS+9LWIJp\+0iLfkdsadsai9dasldsadasC8E

log("aws stuff");
log("S3_End_Point:", S3_End_Point);
log("S3_Bucket_Name:", S3_Bucket_Name);
log("AWS_SECRET_ACCESS_KEY:", AWS_SECRET_ACCESS_KEY);

// Queue names - consistent naming convention
let bridge_queue = "bridge_queue";
let cloned_queue = "cloned_queue";
let build_queue = "build_queue";

// Directory for cloned repositories
let cloned_repo = "cloned_repo";

// Create a single connection to RabbitMQ
let connection;
let channel;
let redisClient;

// Deployment status enum - consistent across services
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
      await channel.assertQueue(bridge_queue, { durable: false });
      await channel.assertQueue(cloned_queue, { durable: false });
      await channel.assertQueue(build_queue, { durable: false });
      log("Connected to RabbitMQ");

      log(`Attempting to connect to Redis (${retries} attempts left)...`);
      redisClient = createClient({
        url: redisURI,
      });

      log("Trying to connect to Redis...");
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

/**
 * Clones a repository from a given URL to a folder named with the provided UUID
 * @param {string} repoUrl - GitHub URL to clone
 * @param {string} uuidToDeploy - UUID to use as folder name
 * @returns {string} Full path to the cloned repository
 */
async function cloneRepoHelper(repoUrl, uuidToDeploy) {
  try {
    log("[CLONE] Starting clone of repo:", repoUrl, "with UUID:", uuidToDeploy);

    const uniqueRepoFolder = uuidToDeploy;
    const fullPath = join(cloned_repo, uniqueRepoFolder);

    log("[CLONE] Running git clone command to:", fullPath);
    const proc = Bun.spawn(["git", "clone", repoUrl, fullPath]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`Git clone failed with exit code ${exitCode}`);
    }

    log("[CLONE] Successfully cloned repo to:", fullPath);
    return fullPath;
  } catch (error) {
    log("[CLONE] Error cloning repo:", error);
    throw error;
  }
}

function brideConsumer() {
  log("[CONSUMER] Starting bridge queue consumer");
  channel.prefetch(4);
  channel.consume(bridge_queue, bridgeCallback);

  async function bridgeCallback(msg) {
    if (!msg) return;
    const uuidToDeploy = msg.content.toString();
    log("[BRIDGE] Processing deployment UUID:", uuidToDeploy);

    try {
      let deploymentJobJson = await redisClient.get(uuidToDeploy);
      let deploymentJob = JSON.parse(deploymentJobJson);
      log("[BRIDGE] Loaded deployment job:", deploymentJob);

      let githubUrl = deploymentJob.github_url;
      log("[BRIDGE] Will clone GitHub repo:", githubUrl);

      // Clone the repository
      let clonedPath = await cloneRepoHelper(githubUrl, uuidToDeploy);
      log("[BRIDGE] Repo cloned successfully to:", clonedPath);

      // Update deployment status
      deploymentJob.deployment_status = DeploymentEnum.cloned;
      deploymentJob.cloned_path = clonedPath;
      await redisClient.set(uuidToDeploy, JSON.stringify(deploymentJob));
      log("[BRIDGE] Updated deployment status to CLONED");

      // Send to next queue and acknowledge
      channel.sendToQueue(cloned_queue, Buffer.from(uuidToDeploy));
      log("[BRIDGE] Sent to cloned_queue for building");
      channel.ack(msg);
    } catch (error) {
      log("[BRIDGE] Error processing message:", error);

      // Update deployment as failed
      try {
        let deploymentJobJson = await redisClient.get(uuidToDeploy);
        let deploymentJob = JSON.parse(deploymentJobJson);
        deploymentJob.deployment_status = DeploymentEnum.failed;
        await redisClient.set(uuidToDeploy, JSON.stringify(deploymentJob));
        log("[BRIDGE] Marked deployment as FAILED");
      } catch (redisError) {
        console.error("[BRIDGE] Error updating Redis:", redisError);
      }

      // Always acknowledge the message to prevent requeuing errors , we dont want it to go in infinite loop if there is error
      channel.ack(msg);
    }
  }
}

/**
 * Builds a cloned repository by installing dependencies and running build
 * @param {string} clonedRepoPath - Path to the cloned repository
 * @returns {string} Path to the build output folder
 */
async function buildRepoHelper(clonedRepoPath) {
  log("[BUILD] Starting build process for repo at:", clonedRepoPath);

  try {
    // Run bun install in the repo directory using Bun.spawn with cwd option
    log("[BUILD] Installing dependencies...");
    const installProc = Bun.spawn(["bun", "install"], {
      cwd: clonedRepoPath, // This sets the working directory just for this process
    });

    const installExitCode = await installProc.exited;
    if (installExitCode !== 0) {
      throw new Error(`bun install failed with exit code ${installExitCode}`);
    }

    log("[BUILD] Dependencies installed successfully");

    // Run build script in a separate process , cause if we use main thead then it will interfere with other process like clone, we may clone in the nested folder of the build folder cause we are using main thread and we change the directory to build folder and then clone , so to avoid this we use spawn
    log("[BUILD] Running build command...");
    const buildProc = Bun.spawn(["bun", "run", "build"], {
      cwd: clonedRepoPath,
    });

    const buildExitCode = await buildProc.exited;
    if (buildExitCode !== 0) {
      throw new Error(`bun run build failed with exit code ${buildExitCode}`);
    }

    log("[BUILD] Project built successfully");

    // Determine possible build output directories , sometime its dist or build depending on the project , lets check both
    const distPath = join(clonedRepoPath, "dist");
    const buildPath = join(clonedRepoPath, "build");

    log("[BUILD] Checking for output in:", distPath, "or", buildPath);

    // Check if either "dist" or "build" exists and return the path
    let outputPath;
    try {
      await fs.access(distPath);
      outputPath = distPath;
      log("[BUILD] Found dist folder at:", outputPath);
    } catch (error) {
      try {
        await fs.access(buildPath);
        outputPath = buildPath;
        log("[BUILD] Found build folder at:", outputPath);
      } catch (error) {
        console.error("[BUILD] Neither 'dist' nor 'build' folder found! Build may have failed.");
        throw new Error("Build failed: No output directory found");
      }
    }

    log("[BUILD] Build completed with output at:", outputPath);
    return outputPath;
  } catch (error) {
    console.error("[BUILD] Build error:", error);
    //delete the cloned repo / cloned_repo/uuid whole folder if the build fails as this won't go to s3 upload to be deleted finally if there is error
    await cleanupBuildFolder(clonedRepoPath);
    throw error; // Rethrow for handling in consumer
  }
}

function clonedQueueConsumer() {
  log("[CONSUMER] Starting cloned queue consumer");
  channel.prefetch(1);
  channel.consume(cloned_queue, bridgeCallback);

  async function bridgeCallback(msg) {
    if (!msg) return;
    const uuidToDeploy = msg.content.toString();
    log("[CLONED] Processing cloned repo with UUID:", uuidToDeploy);

    try {
      // Get deployment info from Redis
      let deploymentJobJson = await redisClient.get(uuidToDeploy);
      let deploymentJob = JSON.parse(deploymentJobJson);
      log("[CLONED] Loaded deployment job:", deploymentJob);

      let clonedRepoPath = deploymentJob.cloned_path;
      log("[CLONED] Will build repo at path:", clonedRepoPath);

      // Build the repository
      let buildDistPath = await buildRepoHelper(clonedRepoPath);
      log("[CLONED] Build completed with output at:", buildDistPath);

      // Update deployment status
      deploymentJob.deployment_status = DeploymentEnum.build;
      deploymentJob.buildDistPath = buildDistPath;
      await redisClient.set(uuidToDeploy, JSON.stringify(deploymentJob));
      log("[CLONED] Updated deployment status to BUILD");

      // Send to next queue and acknowledge
      channel.sendToQueue(build_queue, Buffer.from(uuidToDeploy));
      log("[CLONED] Sent to build_queue for S3 upload");
      channel.ack(msg);
    } catch (error) {
      log("[CLONED] Error processing message:", error);

      // Update deployment as failed
      try {
        let deploymentJobJson = await redisClient.get(uuidToDeploy);
        let deploymentJob = JSON.parse(deploymentJobJson);
        deploymentJob.deployment_status = DeploymentEnum.failed;
        await redisClient.set(uuidToDeploy, JSON.stringify(deploymentJob));
        log("[CLONED] Marked deployment as FAILED");
      } catch (redisError) {
        console.error("[CLONED] Error updating Redis:", redisError);
      }

      // Always acknowledge the message to prevent requeuing errors , we dont want it to go in infinite loop if there is error
      channel.ack(msg);
    }
  }
}

/**
 * Fix paths in index.html to add deployment prefix
 * @param {string} buildPath - Path to the build output folder
 * @param {string} deploymentId - UUID for this deployment
 */
async function fixHtmlPaths(buildPath, deploymentId) {
  const indexPath = `${buildPath}/index.html`;
  log("[FIX-HTML] Fixing paths in:", indexPath);

  try {
    // Read the file using Bun.file
    const indexFile = Bun.file(indexPath);
    let html = await indexFile.text();
    log("[FIX-HTML] Read HTML file, size:", html.length);

    // Add the deployment prefix to all absolute paths
    const prefix = `deployment-${deploymentId}`;

    // Replace paths to include the prefix cause we are deploying to s3 and we need to add the prefix to the path , cause by default it will look for the path in the root of the bucket and we are not deploying in the root of the bucket we are deploying in the folder with the prefix so we need to add the prefix to the path
    html = html.replace(/href="\//g, `href="/${prefix}/`);
    html = html.replace(/src="\//g, `src="/${prefix}/`);
    log("[FIX-HTML] Updated paths with prefix:", prefix);

    // Write back to the file using Bun.write
    await Bun.write(indexPath, html);
    log("[FIX-HTML] Fixed paths in index.html successfully");
  } catch (error) {
    console.error("[FIX-HTML] Error fixing paths:", error);
    throw error;
  }
}

/**
 * Upload build output to S3
 * @param {string} buildPath - Path to the build output folder
 * @param {string} deploymentId - UUID for this deployment
 * @returns {string} URL to the deployed site
 */
async function uploadToS3Helper(buildPath, deploymentId) {
  const storagePath = `deployment-${deploymentId}`;
  log("[S3] Preparing to upload to S3, path:", storagePath);

  try {
    await fixHtmlPaths(buildPath, deploymentId);

    log(`[S3] Uploading build from ${buildPath} to s3://${S3_Bucket_Name}/${storagePath}`);

    const uploadProc = Bun.spawn(["aws", "s3", "sync", buildPath, `s3://${S3_Bucket_Name}/${storagePath}`, `--endpoint=https://${S3_End_Point}`, "--acl=public-read"], {
      env: {
        ...process.env, // Spread the current environment
        AWS_ACCESS_KEY_ID: AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: AWS_SECRET_ACCESS_KEY,
      },
    });

    const output = await new Response(uploadProc.stdout).text();
    log("[S3] Upload process output:", output);

    // Wait for the process to complete
    const exitCode = await uploadProc.exited;

    if (exitCode !== 0) {
      const errorOutput = await new Response(uploadProc.stderr).text();
      throw new Error(`Upload failed with exit code ${exitCode}: ${errorOutput}`);
    }
    log(`[S3] Upload completed successfully`);

    // Return the URL to the deployed site
    const deployedUrl = `https://${S3_Bucket_Name}.${S3_End_Point}/${storagePath}/index.html`;
    log("[S3] Deployed URL:", deployedUrl);
    return deployedUrl;
  } catch (error) {
    console.error("[S3] Upload error:", error);
    throw error;
  } finally {
    // Get the parent directory (cloned_repo/uuid)
    const parentDir = join(buildPath, "..");
    log("[S3] Parent directory to clean up:", parentDir);

    // Clean up the entire folder
    await cleanupBuildFolder(parentDir);
  }
}

/**
 * Clean up a folder after deployment
 * @param {string} folderPath - Path to the folder to clean up
 */
async function cleanupBuildFolder(folderPath) {
  try {
    log(`[CLEANUP] Removing folder: ${folderPath}`);
    // Recursively remove directory and all contents
    await rm(folderPath, { recursive: true, force: true });
    log(`[CLEANUP] Successfully removed folder: ${folderPath}`);
  } catch (error) {
    console.error("[CLEANUP] Error during cleanup:", error);
  }
}

function buildQueueConsumer() {
  log("[CONSUMER] Starting build queue consumer");
  channel.prefetch(1);
  channel.consume(build_queue, bridgeCallback);

  async function bridgeCallback(msg) {
    if (!msg) return;
    const uuidToDeploy = msg.content.toString();
    log("[BUILD-Q] Processing build with UUID:", uuidToDeploy);

    try {
      // Get deployment info from Redis
      let deploymentJobJson = await redisClient.get(uuidToDeploy);
      let deploymentJob = JSON.parse(deploymentJobJson);
      log("[BUILD-Q] Loaded deployment job:", deploymentJob);

      let buildDistPath = deploymentJob.buildDistPath;
      log("[BUILD-Q] Will upload build from path:", buildDistPath);

      // Upload to S3
      let deployedUrl = await uploadToS3Helper(buildDistPath, uuidToDeploy);
      log("[BUILD-Q] Upload completed, deployed URL:", deployedUrl);

      // Update deployment status to deployed
      deploymentJob.deployment_status = DeploymentEnum.deployed;
      deploymentJob.deployedUrl = deployedUrl;
      await redisClient.set(uuidToDeploy, JSON.stringify(deploymentJob));
      log("[BUILD-Q] Updated deployment status to DEPLOYED");

      // Acknowledge the message
      channel.ack(msg);
    } catch (error) {
      log("[BUILD-Q] Error processing message:", error);

      // Update deployment as failed
      try {
        let deploymentJobJson = await redisClient.get(uuidToDeploy);
        let deploymentJob = JSON.parse(deploymentJobJson);
        deploymentJob.deployment_status = DeploymentEnum.failed;
        await redisClient.set(uuidToDeploy, JSON.stringify(deploymentJob));
        log("[BUILD-Q] Marked deployment as FAILED");
      } catch (redisError) {
        console.error("[BUILD-Q] Error updating Redis:", redisError);
      }

      // Always acknowledge the message to prevent requeuing errors
      channel.ack(msg);
    }
  }
}

async function main() {
  log("Starting service...");
  await setupRabbitMQAndRedis();
  await runHttpServer();
  await setupDirectories();
  log("Now running all consumers");
  brideConsumer();
  clonedQueueConsumer();
  buildQueueConsumer();
}

function runHttpServer() {
  return new Promise(function (resolve, reject) {
    app.listen(port, "0.0.0.0", (err) => {
      if (err) {
        reject(err); // If there's an error, reject the Promise
      } else {
        log(`Server listening on port ${port}`);
        resolve(); // Resolve the Promise only when the server starts
      }
    });
  });
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
  try {
    log("Shutting down service...");
    if (channel) await channel.close();
    if (connection) await connection.close();
    log("RabbitMQ connection closed");
  } catch (error) {
    console.error("Error closing RabbitMQ connection:", error);
  }
  process.exit(0);
});

async function setupDirectories() {
  await mkdir(cloned_repo, { recursive: true });
  log("Repository directory created:", cloned_repo);
}

main();
