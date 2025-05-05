require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const { title } = require("process");

// ====== App Setup ======
const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());

// ====== MongoDB Setup ======
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

let jobsCollection;
let messagesCollection;

async function connectToDatabase() {
  try {
    await client.connect();
    const db = client.db("jobHive");
    jobsCollection = db.collection("jobs");
    messagesCollection = db.collection("messages");
    await messagesCollection.createIndex({
      sender: 1,
      receiver: 1,
      timestamp: -1,
    });
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
  }
}

connectToDatabase();

// ====== Socket.IO Setup ======
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const connectedUsers = new Map(); // email -> socket.id

io.on("connection", (socket) => {
  console.log(`🟢 New client connected: ${socket.id}`);

  socket.on("registerUser", (email) => {
    connectedUsers.set(email, socket.id);
    console.log(`📌 User registered: ${email} → ${socket.id}`);
  });

  socket.on("newJobPosted", (data) => {
    console.log(`📢 Broadcasting new job: ${data.title}`);
    io.emit("newJobPosted", data);
  });

  //apply job notification alert
  socket.on("jobApplication", ({ employer, title, applicantName }) => {
    console.log(
      `📨 Job application from ${applicantName} to ${employer} for ${title}`
    );
    const employerSocketId = connectedUsers.get(employer);
    if (employerSocketId) {
      io.to(employerSocketId).emit("jobApplicationNotification", {
        title,
        applicantName,
      });
      console.log(`✅ Notified employer (${employer})`);
    } else {
      console.log(`❌ Employer not connected: ${employer}`);
    }
  });

  socket.on("sendMessage", async ({ senderEmail, receiverEmail, text }) => {
    const roomId = generateRoomId(senderEmail, receiverEmail);
    const timestamp = new Date();
    const message = { senderEmail, receiverEmail, text, roomId, timestamp };

    console.log(
      `💬 New message from ${senderEmail} to ${receiverEmail}: "${text}"`
    );

    try {
      await messagesCollection.insertOne(message);
      console.log(`🗂️ Message saved to DB (room: ${roomId})`);

      const receiverSocketId = connectedUsers.get(receiverEmail);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("receiveMessage", message);
        console.log(`📤 Delivered to: ${receiverEmail}`);
      } else {
        console.log(`❌ Receiver not connected: ${receiverEmail}`);
      }
    } catch (error) {
      console.error("❌ Error saving/sending message:", error);
    }
  });

  socket.on("disconnect", () => {
    for (const [email, id] of connectedUsers.entries()) {
      if (id === socket.id) {
        connectedUsers.delete(email);
        console.log(`🔴 Disconnected: ${email} (${socket.id})`);
        break;
      }
    }
  });
});

// ====== Helper ======
function generateRoomId(user1, user2) {
  return [user1, user2].sort().join("_");
}

// ====== API Routes ======

//for notify all the jobseeker
app.post("/api/emit-job-post", (req, res) => {
  const { title, industry } = req.body;
  io.emit("newJobPosted", { title, industry });
  console.log(`🔔 Emitted new job: ${title}`);
  res.send({ success: true });
});

app.post("/api/emit-apply", async (req, res) => {
  const { jobId, applicantName, employer } = req.body;
  console.log("📩 Emit Apply - Incoming Payload:", req.body);
  console.log("jobId", jobId);
  console.log("applicantName", applicantName);
  console.log("employer", employer);
  try {
    const job = await jobsCollection.findOne({ _id: new ObjectId(jobId) });

    const employerSocketId = connectedUsers.get(employer);
    console.log("🧩 Employer socket ID:", employerSocketId);
    if (employerSocketId) {
      io.to(employerSocketId).emit("jobApplicationNotification", {
        title: job.title,
        applicantName,
      });
      console.log(`📨 Application sent to ${employer}`);
    } else {
      console.log(`❌ Employer not connected: ${employer}`);
    }

    res.send({ success: true, message: "Application notification sent" });
  } catch (error) {
    console.error("❌ Error during job apply:", error);
    res.status(500).send({ error: "Failed to apply." });
  }
});

// ====== Server Start ======
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
