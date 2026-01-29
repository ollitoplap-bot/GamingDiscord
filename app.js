import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase, ref, set, push, onValue, child, update, remove } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

// ===== Firebase Config =====
const firebaseConfig = {
  apiKey: "AIzaSyDSVBA8wkrtVhIkZzbEuTGxpD3t4owdRQY",
  authDomain: "free-voice-chat-7e5db.firebaseapp.com",
  databaseURL: "https://free-voice-chat-7e5db-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "free-voice-chat-7e5db",
  storageBucket: "free-voice-chat-7e5db.appspot.com",
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
const userId = Date.now().toString();
let peers = {};
let audioElements = {};
let iceListeners = {}; // Track which ICE paths we are listening to

// ===== WebRTC =====
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// ===== Get Microphone =====
navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
  localStream = stream;

  // ===== Add self to DB =====
  const userRef = child(roomRef, `users/${userId}`);
  set(userRef, { speaking: false, muted: false });
  userRef.onDisconnect().remove(); // auto-remove user on disconnect

  // ===== Speaking detection =====
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  src.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);

  function detectVoice() {
    analyser.getByteTimeDomainData(data);
    const speaking = data.some(v => Math.abs(v - 128) > 10) && !muted;
    update(userRef, { speaking });
    requestAnimationFrame(detectVoice);
  }
  detectVoice();

  // ===== Listen for users =====
  onValue(child(roomRef, 'users'), snapshot => {
    const users = snapshot.val() || {};
    renderUsers(users);

    // Remove disconnected peers
    for (const id in peers) {
      if (!users[id]) {
        peers[id].close();
        delete peers[id];
        if (audioElements[id]) {
          audioElements[id].remove();
          delete audioElements[id];
        }
      }
    }

    // Create peers for new users
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
  usersContainer.innerHTML = "";
  for (const id in users) {
    const div = document.createElement("div");
    div.className = "user";

    const ring = document.createElement("div");
    ring.className = "ring" + (users[id].speaking ? " active" : "");
    div.appendChild(ring);

    const img = document.createElement("img");
    img.className = "avatar";
    img.src = "https://better-default-discord.netlify.app/Icons/Gradient-Violet.png";
    div.appendChild(img);

    usersContainer.appendChild(div);
  }
}

// ===== Create Peer Connection =====
function createPeerConnection(otherId) {
  if (peers[otherId]) return;
  const pc = new RTCPeerConnection(rtcConfig);
  peers[otherId] = pc;

  // Add local tracks
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // Create <audio> element for remote user
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

  // ===== ICE candidates =====
  pc.onicecandidate = e => {
    if (e.candidate) {
      const iceRef = push(child(roomRef, `ice/${userId}_${otherId}`), JSON.stringify(e.candidate));
      iceRef.onDisconnect().remove();
    }
  };

  // ===== Offer =====
  if (userId > otherId) {
    pc.createOffer().then(offer => {
      const offerRef = child(roomRef, `offers/${userId}_${otherId}`);
      set(offerRef, JSON.stringify(offer));
      offerRef.onDisconnect().remove();
      pc.setLocalDescription(offer);
    });
  }

  // ===== Listen for Offer =====
  onValue(child(roomRef, `offers/${otherId}_${userId}`), snap => {
    if (snap.exists() && !pc.currentRemoteDescription) {
      const offer = JSON.parse(snap.val());
      pc.setRemoteDescription(offer).then(() => {
        remove(child(roomRef, `offers/${otherId}_${userId}`));

        pc.createAnswer().then(answer => {
          const answerRef = child(roomRef, `answers/${userId}_${otherId}`);
          set(answerRef, JSON.stringify(answer));
          answerRef.onDisconnect().remove();
          pc.setLocalDescription(answer);
        });
      });
    }
  });

  // ===== Listen for Answer =====
  onValue(child(roomRef, `answers/${otherId}_${userId}`), snap => {
    if (snap.exists() && !pc.currentRemoteDescription) {
      pc.setRemoteDescription(JSON.parse(snap.val()));
      remove(child(roomRef, `answers/${otherId}_${userId}`));
    }
  });

  // ===== Optimized Remote ICE Listener =====
  const icePath = `ice/${otherId}_${userId}`;
  if (!iceListeners[icePath]) {
    iceListeners[icePath] = true;
    onValue(child(roomRef, icePath), snap => {
      snap.forEach(c => {
        pc.addIceCandidate(JSON.parse(c.val()));
        remove(child(roomRef, `${icePath}/${c.key}`)); // remove after applying
      });
    });
  }
}
