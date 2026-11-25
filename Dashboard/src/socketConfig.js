/**
 * Resolve the Socket.IO HTTP base URL from the page host so phones
 * opening http://<LAN-IP>:3000 talk to http://<LAN-IP>:8080, not localhost.
 */
export function getSocketHttpUrl() {
  if (typeof window === 'undefined') {
    return process.env.REACT_APP_SOCKET_URL || 'http://localhost:8080';
  }

  const host = window.location.hostname || 'localhost';
  if (host !== 'localhost' && host !== '127.0.0.1') {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${host}:8080`;
  }

  return process.env.REACT_APP_SOCKET_URL || 'http://localhost:8080';
}

/**
 * Python posts drone notes to the API server (api-server.js) on port 3000.
 * The dashboard listens there for `api-input-received` broadcasts.
 */
export function getApiHttpUrl() {
  if (typeof window === 'undefined') {
    return process.env.REACT_APP_API_URL || 'http://localhost:3000';
  }

  const host = window.location.hostname || 'localhost';
  if (host !== 'localhost' && host !== '127.0.0.1') {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${host}:3000`;
  }

  return process.env.REACT_APP_API_URL || 'http://localhost:3000';
}
