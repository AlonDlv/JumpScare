import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './App.css';
import logo from './assets/JumpsCareLogo.png';
import jumpscareData from './jumpscares.json';

const MIN_TIMER = 3;
const MAX_TIMER = 10;
const DOT_SIZE = 28;
const NETFLIX_WATCH_URL = /^https?:\/\/(?:www\.)?netflix\.com\/watch\//i;
const MOVIE_TITLES = Object.keys(jumpscareData);

function normalizeTitle(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\w\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTitleMatch(candidate, actual) {
  const normalizedCandidate = normalizeTitle(candidate);
  const normalizedActual = normalizeTitle(actual);

  if (!normalizedCandidate || !normalizedActual) {
    return -1;
  }

  if (normalizedCandidate === normalizedActual) {
    return 1000;
  }

  if (
    normalizedCandidate.startsWith(normalizedActual) ||
    normalizedActual.startsWith(normalizedCandidate)
  ) {
    return 800 - Math.abs(normalizedCandidate.length - normalizedActual.length);
  }

  if (
    normalizedCandidate.includes(normalizedActual) ||
    normalizedActual.includes(normalizedCandidate)
  ) {
    return 600 - Math.abs(normalizedCandidate.length - normalizedActual.length);
  }

  const actualWords = normalizedActual.split(' ');
  const candidateWords = new Set(normalizedCandidate.split(' '));
  const sharedWords = actualWords.filter(word => candidateWords.has(word)).length;

  return sharedWords >= Math.min(2, actualWords.length)
    ? sharedWords * 25 - Math.abs(candidateWords.size - actualWords.length)
    : -1;
}

function findBestMovieMatch(movieTitle) {
  let bestMatch = null;
  let bestScore = -1;

  for (const candidate of MOVIE_TITLES) {
    const score = scoreTitleMatch(candidate, movieTitle);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestScore >= 0 ? bestMatch : null;
}

function parseJumpscareSeconds(entry) {
  const rawTimestamps = Array.isArray(entry?.time_stamps) ? entry.time_stamps : [];

  return rawTimestamps
    .map(timestamp => {
      const [hours = 0, minutes = 0, seconds = 0] = timestamp
        .split(':')
        .map(Number);

      return hours * 3600 + minutes * 60 + seconds;
    })
    .filter(Number.isFinite);
}

function queryActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs[0] ?? null);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve(response ?? null);
    });
  });
}

function injectContentScript(tabId) {
  if (!chrome.scripting?.executeScript) {
    return Promise.resolve(false);
  }

  return new Promise(resolve => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        files: ['content.js']
      },
      () => {
        resolve(!chrome.runtime.lastError);
      }
    );
  });
}

async function requestPlaybackState(tab) {
  if (!tab?.id || !NETFLIX_WATCH_URL.test(tab.url ?? '')) {
    return null;
  }

  const initialResponse = await sendMessageToTab(tab.id, { action: 'getState' });
  if (initialResponse) {
    return initialResponse;
  }

  const injected = await injectContentScript(tab.id);
  if (!injected) {
    return null;
  }

  return sendMessageToTab(tab.id, { action: 'getState' });
}

export default function App() {
  const [warn, setWarn] = useState(
    () => JSON.parse(localStorage.getItem('warn')) ?? false
  );
  const [mute, setMute] = useState(
    () => JSON.parse(localStorage.getItem('mute')) ?? false
  );
  const [skip, setSkip] = useState(
    () => JSON.parse(localStorage.getItem('skip')) ?? false
  );
  const [timer, setTimer] = useState(() => {
    const saved = localStorage.getItem('timer');
    return saved !== null ? Number(saved) : MIN_TIMER;
  });
  const [movieTitle, setMovieTitle] = useState(null);
  const [currentTime, setCurrentTime] = useState(null);
  const [jumpscares, setJumpscares] = useState([]);

  const rangeRef = useRef(null);
  const [rangeWidth, setRangeWidth] = useState(0);

  useEffect(() => {
    localStorage.setItem('timer', timer.toString());
  }, [timer]);

  useLayoutEffect(() => {
    const updateWidth = () => {
      if (rangeRef.current) {
        setRangeWidth(rangeRef.current.offsetWidth);
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);

    return () => {
      window.removeEventListener('resize', updateWidth);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const clearPlaybackState = () => {
      if (cancelled) {
        return;
      }

      setMovieTitle(null);
      setCurrentTime(null);
    };

    const syncPlaybackState = async () => {
      const activeTab = await queryActiveTab();
      if (cancelled) {
        return;
      }

      if (!activeTab?.id || !NETFLIX_WATCH_URL.test(activeTab.url ?? '')) {
        clearPlaybackState();
        return;
      }

      const response = await requestPlaybackState(activeTab);
      if (cancelled) {
        return;
      }

      if (!response) {
        return;
      }

      const nextTitle =
        typeof response.title === 'string' && response.title.trim()
          ? response.title.trim()
          : null;
      const nextTime =
        typeof response.currentTime === 'number' &&
        Number.isFinite(response.currentTime)
          ? response.currentTime
          : null;

      setMovieTitle(previousTitle => nextTitle ?? previousTitle);
      setCurrentTime(previousTime => nextTime ?? previousTime);
    };

    syncPlaybackState();
    const intervalId = window.setInterval(syncPlaybackState, 500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!movieTitle) {
      setJumpscares([]);
      return;
    }

    const matchedTitle = findBestMovieMatch(movieTitle);
    if (!matchedTitle) {
      setJumpscares([]);
      return;
    }

    setJumpscares(parseJumpscareSeconds(jumpscareData[matchedTitle]));
  }, [movieTitle]);

  const usableWidth = Math.max(rangeWidth - DOT_SIZE, 0);
  const sliderFraction = (timer - MIN_TIMER) / (MAX_TIMER - MIN_TIMER);
  const sliderLeft = usableWidth * sliderFraction + DOT_SIZE / 2;

  const nextScare =
    typeof currentTime === 'number'
      ? jumpscares.find(timestamp => timestamp > currentTime)
      : null;
  const secondsToNextScare =
    nextScare != null && typeof currentTime === 'number'
      ? Math.ceil(nextScare - currentTime)
      : null;

  return (
    <div className="container">
      <img src={logo} alt="JumpScare Logo" className="logo" />

      <div className="control">
        <label htmlFor="warn">WARN</label>
        <div className="toggle">
          <input
            type="checkbox"
            id="warn"
            checked={warn}
            onChange={() => {
              const nextValue = !warn;
              setWarn(nextValue);
              localStorage.setItem('warn', JSON.stringify(nextValue));
            }}
          />
          <span className="slider" />
        </div>
      </div>

      <div className="control">
        <label htmlFor="mute">MUTE</label>
        <div className="toggle">
          <input
            type="checkbox"
            id="mute"
            checked={mute}
            onChange={() => {
              const nextValue = !mute;
              setMute(nextValue);
              localStorage.setItem('mute', JSON.stringify(nextValue));
            }}
          />
          <span className="slider" />
        </div>
      </div>

      <div className="control">
        <label htmlFor="skip">SKIP</label>
        <div className="toggle">
          <input
            type="checkbox"
            id="skip"
            checked={skip}
            onChange={() => {
              const nextValue = !skip;
              setSkip(nextValue);
              localStorage.setItem('skip', JSON.stringify(nextValue));
            }}
          />
          <span className="slider" />
        </div>
      </div>

      <div className="control">
        <label htmlFor="timer">TIMER</label>
        <div className="range-container">
          <input
            ref={rangeRef}
            type="range"
            id="timer"
            min={MIN_TIMER}
            max={MAX_TIMER}
            value={timer}
            onChange={event => setTimer(Number(event.target.value))}
          />
          <div className="range-value" style={{ left: `${sliderLeft}px` }}>
            {timer}
          </div>
        </div>
      </div>

      <div className="control">
        <label>TITLE</label>
        <span>{movieTitle || '--'}</span>
      </div>

      <div className="control">
        <label>NEXT SCARE</label>
        <span style={{ fontFamily: 'sans-serif', fontSize: '1rem' }}>
          {secondsToNextScare != null ? `${secondsToNextScare}s` : '--'}
        </span>
      </div>
    </div>
  );
}
