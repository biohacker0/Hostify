FROM node
WORKDIR /app

# Copy only package.json first (to leverage caching)
COPY package.json package-lock.json ./

# Install dependencies separately (cached unless package.json changes)
RUN npm install

# Now copy the rest of the files
COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev"]
