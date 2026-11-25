// src/App.js
import React, { useEffect, useState } from 'react';
import './App.css';
import DroneChoirPerformer from './DroneChoirPerformer';
import TenorPage from './TenorPage';
import AltoPage from './AltoPage';

const SINGLE_VOICE_PARAMS = ['high', 'mid-high', 'low-mid', 'low'];

function App() {
  const [currentView, setCurrentView] = useState('main');
  const [isSingleVoicePage, setIsSingleVoicePage] = useState(false);
  
  // Check URL parameters on component mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const voice = params.get('voice');
    const singleVoice = SINGLE_VOICE_PARAMS.some((param) => params.has(param));
    setIsSingleVoicePage(singleVoice);
    
    if (voice === 'tenor') {
      setCurrentView('tenor');
    } else if (voice === 'alto') {
      setCurrentView('alto');
    } else {
      setCurrentView('main');
    }
  }, []);
  
  // Render the appropriate view based on the URL parameter
  return (
    <div className={`App${isSingleVoicePage ? ' single-voice-app' : ''}`}>
      {currentView === 'tenor' ? (
        <TenorPage />
      ) : currentView === 'alto' ? (
        <AltoPage />
      ) : isSingleVoicePage ? (
        <DroneChoirPerformer />
      ) : (
        <>
          <header className="App-header">
            <h1>Transmission Performance System</h1>
          </header>
          <main>
            <DroneChoirPerformer />
          </main>
          <footer>
            <p>Transmission - {new Date().getFullYear()}</p>
          </footer>
        </>
      )}
    </div>
  );
}

export default App;
