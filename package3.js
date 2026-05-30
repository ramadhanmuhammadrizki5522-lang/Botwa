{
  "name": "whatsapp-group-bot",
  "version": "1.0.0",
  "description": "WhatsApp Group Bot - Anti Spam, Anti Link, Anti Toxic, Auto Reply",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "mysql2": "^3.6.0",
    "dotenv": "^16.3.1",
    "cors": "^2.8.5",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2",
    "qrcode": "^1.5.3",
    "socket.io": "^4.6.2",
    "whatsapp-web.js": "^1.23.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}