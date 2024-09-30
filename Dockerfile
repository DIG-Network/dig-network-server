# Use the official Ubuntu image as the base image
FROM ubuntu:latest

# Set the working directory inside the container
WORKDIR /app

# Install curl, build-essential, pkg-config, and other dependencies
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    libsecret-1-dev \
    pkg-config \
    dbus \
    && rm -rf /var/lib/apt/lists/*

# Generate the machine-id
RUN dbus-uuidgen > /etc/machine-id

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g npm@latest

# Copy the current directory contents into the container at /app
COPY . .

# Install any needed packages specified in package.json
RUN npm install
RUN npm i datalayer-driver-linux-x64-gnu
RUN npm run build

# Rebuild any native modules for the current environment
RUN npm rebuild

# Expose the port the app runs on
EXPOSE 4162

# Run npm start command when the container launches
CMD ["node", "dist/cluster.js"]
