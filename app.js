import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, set, push, onValue, child, update, get, remove, onDisconnect } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// ===== Firebase Config =====
const firebaseConfig = {
  apiKey: "AIzaSyDSVBA8wkrtVhIkZzbEuTGxpD3t4owdRQY",
  authDomain: "free-voice-chat-7e5db.firebaseapp.com",
  databaseURL: "https://free-voice-chat-7e5db-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "free-voice-chat-7e5db",
  storageBucket: "free-voice-chat-7e5db.firebasestorage.app",
  messagingSenderId: "1092180044740",
  appId: "1:1092180044740:web:422408a96e0c5d51f91291"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const roomRef = ref(db, 'room1');

// ===== UI =====
const usersContainer = document.getElementById("users-container");
const muteBtn = document.getElementById("muteBtn");
const muteIcon = document.getElementById("muteIcon");

// ===== State =====
let localStream;
let muted = false;
let userId = Date.now().toString();
let peers = {};           // RTCPeerConnections keyed by otherId
let audioElements = {};   // <audio> per peer

// ===== WebRTC Config =====
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// ===== Get Microphone =====
navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
  localStream = stream;

  // Add self to DB
  set(child(roomRef, `users/${userId}`), { speaking: false, muted: false });

  // >>> onDisconnect presence removal <<<
  onDisconnect(child(roomRef, `users/${userId}`)).remove();

  // >>> signaling cleanup on disconnect <<<
  onDisconnect(child(roomRef, `offers`)).update({ [`${userId}_*`]: null });
  onDisconnect(child(roomRef, `answers`)).update({ [`${userId}_*`]: null });
  onDisconnect(child(roomRef, `ice`)).update({ [`${userId}_*`]: null });

  // Speaking detection
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  src.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);

  function detectVoice() {
    analyser.getByteTimeDomainData(data);
    const speaking = data.some(v => Math.abs(v - 128) > 10) && !muted;
    update(child(roomRef, `users/${userId}`), { speaking });
    requestAnimationFrame(detectVoice);
  }
  detectVoice();

  // Listen for users
  onValue(child(roomRef, 'users'), snapshot => {
    const users = snapshot.val() || {};
    renderUsers(users);

    for (const id in users) {
      if (id !== userId && !peers[id]) {
        createPeerConnection(id);
      }
    }
  });
});

// ===== Mute Button =====
muteBtn.onclick = () => {
  muted = !muted;
  if (localStream) localStream.getAudioTracks()[0].enabled = !muted;
  muteIcon.src = muted ?
    "https://cdn-icons-png.flaticon.com/512/107/107037.png" :
    "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ2FhSl1YBoCZEFlUS7OdLiTwE-dfPCHQYoOA&s";
  update(child(roomRef, `users/${userId}`), { muted });
};

// ===== Render Users =====
function renderUsers(users) {
  usersContainer.innerHTML = ""; // clear first
  for (const id in users) {
    const div = document.createElement("div");
    div.className = "user";

    const ring = document.createElement("div");
    ring.className = "ring" + (users[id].speaking ? " active" : "");
    div.appendChild(ring);

    const img = document.createElement("img");
    img.className = "avatar";
    img.src = "https://better-default-discord.netlify.app/Icons/Gradient-Violet.png"; // same avatar for all
    div.appendChild(img);

    usersContainer.appendChild(div);
  }
}

// ===== Create Peer Connection =====
function createPeerConnection(otherId) {
  if (peers[otherId]) return; // prevent duplicates
  const pc = new RTCPeerConnection(rtcConfig);
  peers[otherId] = pc;

  // Add local tracks
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // Create <audio> element once
  if (!audioElements[otherId]) {
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.volume = 1;
    audioElements[otherId] = audioEl;
    document.body.appendChild(audioEl);
  }

  pc.ontrack = e => {
    audioElements[otherId].srcObject = e.streams[0];
  };

  pc.onicecandidate = e => {
    if (e.candidate) push(child(roomRef, `ice/${userId}_${otherId}`), JSON.stringify(e.candidate));
  };

  // Only one peer makes offer (higher userId)
  if (userId > otherId) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      set(child(roomRef, `offers/${userId}_${otherId}`), JSON.stringify(offer));
    });
  }

  // Listen for offer
  onValue(child(roomRef, `offers/${otherId}_${userId}`), snap => {
    if (snap.exists() && !pc.currentRemoteDescription) {
      const offer = JSON.parse(snap.val());
      pc.setRemoteDescription(offer).then(() => {
        pc.createAnswer().then(answer => {
          pc.setLocalDescription(answer);
          set(child(roomRef, `answers/${userId}_${otherId}`), JSON.stringify(answer));
        });
      });
    }
  });

  // Listen for answer
  onValue(child(roomRef, `answers/${otherId}_${userId}`), snap => {
    if (snap.exists() && !pc.currentRemoteDescription) {
      pc.setRemoteDescription(JSON.parse(snap.val()));
    }
  });

  // Listen for remote ICE
  onValue(child(roomRef, `ice/${otherId}_${userId}`), snap => {
    snap.forEach(c => pc.addIceCandidate(JSON.parse(c.val())));
  });
}

// ===== Cleanup on leave =====
window.addEventListener("beforeunload", () => {
  remove(child(roomRef, `users/${userId}`));
});
