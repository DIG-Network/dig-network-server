import { app, PORT } from "./app";

const startNetworkServer = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    try {
      const server = app.listen(PORT, async () => {
        console.log(`DIG Network Server Started`);
        console.log(`Preview your store at: http://localhost:${PORT}`);
      });

      server.on("close", resolve);
    } catch (error) {
      reject(error);
    }
  });
};

export { startNetworkServer };