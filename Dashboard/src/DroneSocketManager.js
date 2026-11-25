// DroneSocketManager.js
import { io } from 'socket.io-client';
import { getSocketHttpUrl } from './socketConfig';

class DroneSocketManager {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.type = null; // 'controller' or 'viewer'
    this.voiceType = null;
    this.listeners = {};
    this.pollInterval = null;
    this.pendingRegistration = null;
  }
  
  // Connect to the WebSocket server
  connect() {
    // If a healthy socket already exists, reuse it
    if (this.socket && (this.socket.connected || this.socket.active)) return;

    // Clean up any stale/closing socket before creating a new one
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
    }

    const socketUrl = getSocketHttpUrl();
    console.log('Connecting to socket server at', socketUrl);
    
    this.socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    
    // Set up connection events
    this.socket.on('connect', () => {
      console.log('Connected to socket server');
      this.isConnected = true;
      this.notifyListeners('connect');

      // Re-register after reconnect so viewers keep receiving start/stop
      if (this.pendingRegistration) {
        this.register(this.pendingRegistration.type, this.pendingRegistration.voiceType);
      }
    });
    
    this.socket.on('disconnect', () => {
      console.log('Disconnected from socket server');
      this.isConnected = false;
      this.notifyListeners('disconnect');
    });

    this.socket.on('connect_error', (error) => {
      // 'timeout' errors are normal during reconnection attempts; demote to log
      if (error.message === 'timeout') {
        console.log('Socket reconnect attempt timed out, retrying…');
      } else {
        console.warn('Socket connection error:', error.message);
      }
      this.notifyListeners('connect_error', error);
    });
    
    // Handle registration response
    this.socket.on('registration-success', (data) => {
      console.log('Registration successful:', data);
      this.type = data.type;
      this.voiceType = data.voiceType || this.voiceType;

      // Notify registration first so clients mark themselves as viewer/controller
      // before applying any initial state payload.
      this.notifyListeners('registered', data);
      
      if (data.initialState) {
        this.notifyListeners('initial-state', data.initialState);
      }
    });
    
    // Handle state updates
    this.socket.on('state-updated', (data) => {
      this.notifyListeners('state-updated', data);
    });
    
    // Handle specific voice state updates
    this.socket.on('voice-state', (data) => {
      this.notifyListeners('voice-state', data);
    });

    this.socket.on('start-voices', (data) => {
      this.notifyListeners('start-voices', data);
    });

    this.socket.on('stop-voices', (data) => {
      this.notifyListeners('stop-voices', data);
    });

    this.socket.on('api-input-received', (data) => {
      this.notifyListeners('api-input-received', data);
    });
  }
  
  // Register as a controller (main dashboard) or viewer (single voice)
  register(type, voiceType = null) {
    this.pendingRegistration = { type, voiceType };
    this.type = type;
    this.voiceType = voiceType;

    if (!this.isConnected || !this.socket) {
      console.warn('Not connected to server yet — will register on connect');
      return;
    }
    
    this.socket.emit('register', { 
      type,
      voiceType
    });
    
    // If this is a viewer with a specific voice, start polling
    if (type === 'viewer' && voiceType) {
      this.startPolling(voiceType);
    } else {
      this.stopPolling();
    }
  }
  
  // Start polling for a specific voice's state
  startPolling(voiceType) {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    
    // Request state only as a slow fallback; push events handle live updates
    this.pollInterval = setInterval(() => {
      if (this.isConnected && this.socket) {
        this.socket.emit('request-voice-state', voiceType);
      }
    }, 2500);
  }
  
  // Stop polling
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
  
  // Send state update to the server (controller only)
  updateState(state) {
    if (!this.socket || !this.isConnected) return;
    if (this.type && this.type !== 'controller') return;
    
    this.socket.emit('state-update', state);
  }

  startVoices(notesByVoice, epoch = null) {
    if (!this.socket || !this.isConnected) {
      console.warn('Cannot start voices — socket not connected');
      return false;
    }

    this.socket.emit('start-voices', {
      voices: notesByVoice,
      epoch,
      timestamp: Date.now(),
    });
    return true;
  }

  stopVoices(voiceTypes = null, epoch = null, fullStop = false) {
    if (!this.socket || !this.isConnected) {
      console.warn('Cannot stop voices — socket not connected');
      return false;
    }

    this.socket.emit('stop-voices', {
      voiceTypes,
      epoch,
      fullStop: fullStop || !voiceTypes,
      timestamp: Date.now(),
    });
    return true;
  }
  
  // Add event listener
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    
    this.listeners[event].push(callback);
  }
  
  // Remove event listener
  off(event, callback) {
    if (!this.listeners[event]) return;
    
    this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
  }
  
  // Notify listeners of an event
  notifyListeners(event, data) {
    if (!this.listeners[event]) return;
    
    this.listeners[event].forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in ${event} listener:`, error);
      }
    });
  }
  
  // Disconnect from the server
  disconnect() {
    this.stopPolling();
    
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    
    this.isConnected = false;
    this.pendingRegistration = null;
  }
}

// Create singleton instance
const socketManager = new DroneSocketManager();

export default socketManager;
