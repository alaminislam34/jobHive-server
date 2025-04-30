require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

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
    console.log(`📢 Broadcasting new job: ${data.jobTitle}`);
    io.emit("newJobPosted", data);
  });

  //apply job notification alert
  socket.on("jobApplication", ({ employerEmail, jobTitle, applicantName }) => {
    console.log(
      `📨 Job application from ${applicantName} to ${employerEmail} for ${jobTitle}`
    );
    const employerSocketId = connectedUsers.get(employerEmail);
    if (employerSocketId) {
      io.to(employerSocketId).emit("jobApplicationNotification", {
        jobTitle,
        applicantName,
      });
      console.log(`✅ Notified employer (${employerEmail})`);
    } else {
      console.log(`❌ Employer not connected: ${employerEmail}`);
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

app.post("/api/jobs", async (req, res) => {
  const job = req.body;
  try {
    const result = await jobsCollection.insertOne(job);
    io.emit("newJobPosted", {
      jobTitle: job.jobTitle,
      companyName: job.companyName,
    });
    console.log(`✅ Job posted: ${job.jobTitle}`);
    res.send({ success: true, insertedId: result.insertedId });
  } catch (error) {
    console.error("❌ Failed to post job:", error);
    res.status(500).send({ error: "Failed to post job." });
  }
});

app.post("/api/apply", async (req, res) => {
  const { jobId, applicantName, employerEmail } = req.body;
  try {
    const job = await jobsCollection.findOne({ _id: new ObjectId(jobId) });
    if (!job) {
      console.warn(`⚠️ Job not found: ${jobId}`);
      return res.status(404).send({ error: "Job not found" });
    }

    const employerSocketId = connectedUsers.get(employerEmail);
    if (employerSocketId) {
      io.to(employerSocketId).emit("jobApplicationNotification", {
        jobTitle: job.jobTitle,
        applicantName,
      });
      console.log(`📨 Application sent to ${employerEmail}`);
    } else {
      console.log(`❌ Employer not connected: ${employerEmail}`);
    }

    res.send({ success: true, message: "Application notification sent" });
  } catch (error) {
    console.error("❌ Error during job apply:", error);
    res.status(500).send({ error: "Failed to apply." });
  }
});

app.post("/api/notify-employer", (req, res) => {
  const { employerEmail, jobTitle, applicantName } = req.body;
  const employerSocketId = connectedUsers.get(employerEmail);

  if (employerSocketId) {
    io.to(employerSocketId).emit("jobApplicationNotification", {
      jobTitle,
      applicantName,
    });
    console.log(`📨 Manually notified employer: ${employerEmail}`);
    res.send({ success: true, message: "Employer notified manually" });
  } else {
    console.log(`❌ Employer not connected: ${employerEmail}`);
    res.status(404).send({ error: "Employer not connected" });
  }
});

// ====== Server Start ======
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
