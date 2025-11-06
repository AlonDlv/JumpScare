import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
import './App.css';
import logo from './assets/JumpsCareLogo.png';
import jumpscareData from './jumpscares.json';

export default function App() {
  // toggles loaded & saved from localStorage
  const [warn, setWarn]     = useState(() => JSON.parse(localStorage.getItem('warn')) ?? false);
  const [mute, setMute]     = useState(() => JSON.parse(localStorage.getItem('mute')) ?? false);
  const [skip, setSkip]     = useState(() => JSON.parse(localStorage.getItem('skip')) ?? false);

  // timer loaded & persisted to localStorage
  const [timer, setTimer]   = useState(() => {
    const saved = localStorage.getItem('timer');
    return saved !== null ? Number(saved) : 3;
  });
  useEffect(() => {
    localStorage.setItem('timer', timer.toString());
  }, [timer]);

  // custom slider dot measurement
  const rangeRef                = useRef(null);
  const [rangeWidth, setRangeWidth] = useState(0);
  const DOT_SIZE                = 28;
  useLayoutEffect(() => {
    const update = () => {
      if (rangeRef.current) setRangeWidth(rangeRef.current.offsetWidth);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const MIN    = 3;
  const MAX    = 10;
  const usable = Math.max(rangeWidth - DOT_SIZE, 0);
  const frac   = (timer - MIN) / (MAX - MIN);
  const leftPx = usable * frac + DOT_SIZE / 2;

  // ─── Netflix integration & debug logs ────────────────────────────────
  const [movieTitle, setMovieTitle]   = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [jumpscares, setJumpscares]   = useState([]);

  useEffect(() => {
    // ask content script for title
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(
        tabs[0].id,
        { action: 'getTitle' },
        (resp) => {
          if (resp?.title) setMovieTitle(resp.title);
        }
      );
    });

    // listen for time updates
    const handleMsg = (msg) => {
      if (msg.action === 'timeUpdate') {
        setCurrentTime(msg.currentTime);
      }
    };
    chrome.runtime.onMessage.addListener(handleMsg);
    return () => {
      chrome.runtime.onMessage.removeListener(handleMsg);
    };
  }, []);

  // ─── Lookup and parse jumpscares based on JSON structure ─────────────
  useEffect(() => {
    if (!movieTitle) {
      setJumpscares([]);
      return;
    }

    // fuzzy‐match JSON key
    const matchedKey = Object.keys(jumpscareData).find(k =>
      k.toLowerCase().includes(movieTitle.toLowerCase().trim())
    );
    if (!matchedKey) {
      setJumpscares([]);
      return;
    }

    const entry = jumpscareData[matchedKey];
    const rawTimestamps = Array.isArray(entry.time_stamps)
      ? entry.time_stamps
      : [];

    // Convert "HH:MM:SS" → seconds
    const secondsArray = rawTimestamps.map(ts => {
      const [h = 0, m = 0, s = 0] = ts.split(':').map(Number);
      return h * 3600 + m * 60 + s;
    });
    setJumpscares(secondsArray);
  }, [movieTitle]);

  // compute time until next scare
  const nextScare = jumpscares.find(ts => ts > currentTime);
  const secsToNext = nextScare != null ? Math.ceil(nextScare - currentTime) : null;

  return (
    <div className="container">
      <img src={logo} alt="JumpScare Logo" className="logo" />

      {/* WARN */}
      <div className="control">
        <label htmlFor="warn">WARN</label>
        <div className="toggle">
          <input
            type="checkbox"
            id="warn"
            checked={warn}
            onChange={() => {
              const nv = !warn;
              setWarn(nv);
              localStorage.setItem('warn', JSON.stringify(nv));
            }}
          />
          <span className="slider" />
        </div>
      </div>

      {/* MUTE */}
      <div className="control">
        <label htmlFor="mute">MUTE</label>
        <div className="toggle">
          <input
            type="checkbox"
            id="mute"
            checked={mute}
            onChange={() => {
              const nv = !mute;
              setMute(nv);
              localStorage.setItem('mute', JSON.stringify(nv));
            }}
          />
          <span className="slider" />
        </div>
      </div>

      {/* SKIP */}
      <div className="control">
        <label htmlFor="skip">SKIP</label>
        <div className="toggle">
          <input
            type="checkbox"
            id="skip"
            checked={skip}
            onChange={() => {
              const nv = !skip;
              setSkip(nv);
              localStorage.setItem('skip', JSON.stringify(nv));
            }}
          />
          <span className="slider" />
        </div>
      </div>

      {/* TIMER */}
      <div className="control">
        <label htmlFor="timer">TIMER</label>
        <div className="range-container">
          <input
            ref={rangeRef}
            type="range"
            id="timer"
            min={MIN}
            max={MAX}
            value={timer}
            onChange={e => setTimer(Number(e.target.value))}
          />
          <div
            className="range-value"
            style={{ left: `${leftPx}px` }}
          >
            {timer}
          </div>
        </div>
      </div>

      {/* TITLE */}
      <div className="control">
        <label>TITLE</label>
        <span>{movieTitle || '–'}</span>
      </div>

      {/* NEXT SCARE */}
      <div className="control">
        <label>NEXT SCARE</label>
        <span style={{ fontFamily: 'sans-serif', fontSize: '1rem' }}>
          {secsToNext != null ? `${secsToNext}s` : '--'}
        </span>
      </div>
    </div>
  );
}
