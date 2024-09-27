import cluster, { Worker } from "cluster";

// Check if the current process is the master
if (cluster.isMaster) {
  // Set pool size to the value from the environment or default to 1
  const poolSize: number = parseInt(process.env.CONCURRENT_JOBS || "1", 10);

  // Fork the workers based on the pool size
  for (let i = 0; i < poolSize; i++) {
    cluster.fork();
  }

  // Event listener for when a worker exits
  cluster.on("exit", (worker: Worker, code: number, signal: string) => {
    console.info(
      `Worker ${worker.process.pid} died with code ${code}, signal ${signal}`
    );
  });

  // Event listener for when a worker is online
  cluster.on("online", (worker: Worker) => {
    console.info(
      `Worker ${worker.id}, ${
        Object.keys(cluster.workers || {}).length
      } workers are now online`
    );
  });

  // Check every 250ms if any workers have died and replace them
  setInterval(() => {
    const numWorkers = Object.keys(cluster.workers || {}).length;
    if (numWorkers < poolSize) {
      cluster.fork();
    }
  }, 250);
} else {
  // Import the application
  import("./");
}
