import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './App.css';
import logo from './assets/JumpsCareLogo.png';
import {
  DEFAULT_SETTINGS,
  MAX_TIMER,
  MIN_TIMER,
  loadSettings,
  saveSettings,
  subscribeToSettings
} from './extension-settings';

const DOT_SIZE = 28;
const NETFLIX_WATCH_URL = /^https?:\/\/(?:www\.)?netflix\.com\/watch\//i;

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
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [movieTitle, setMovieTitle] = useState(null);
  const [secondsToNextScare, setSecondsToNextScare] = useState(null);

  const rangeRef = useRef(null);
  const [rangeWidth, setRangeWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void loadSettings().then(loadedSettings => {
      if (!cancelled) {
        setSettings(loadedSettings);
      }
    });

    const unsubscribe = subscribeToSettings(nextSettings => {
      if (!cancelled) {
        setSettings(nextSettings);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

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
      setSecondsToNextScare(null);
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
      if (cancelled || !response) {
        return;
      }

      const nextTitle =
        typeof response.title === 'string' && response.title.trim()
          ? response.title.trim()
          : null;
      const nextSecondsToNextScare =
        typeof response.secondsToNextScare === 'number' &&
        Number.isFinite(response.secondsToNextScare)
          ? response.secondsToNextScare
          : null;

      setMovieTitle(previousTitle => nextTitle ?? previousTitle);
      setSecondsToNextScare(nextSecondsToNextScare);
    };

    void syncPlaybackState();
    const intervalId = window.setInterval(() => {
      void syncPlaybackState();
    }, 500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const updateSetting = (key, value) => {
    setSettings(previousSettings => ({
      ...previousSettings,
      [key]: value
    }));

    void saveSettings({ [key]: value });
  };

  const usableWidth = Math.max(rangeWidth - DOT_SIZE, 0);
  const sliderFraction = (settings.timer - MIN_TIMER) / (MAX_TIMER - MIN_TIMER);
  const sliderLeft = usableWidth * sliderFraction + DOT_SIZE / 2;
  const areFeatureTogglesDisabled = !settings.enabled;
  const isTimerDisabled = !settings.enabled;

  return (
    <div className="container">
      <img src={logo} alt="JumpScare Logo" className="logo" />

      <div className="control">
        <label htmlFor="extension-toggle">EXTENSION</label>
        <div className="toggle">
          <input
            type="checkbox"
            id="extension-toggle"
            checked={settings.enabled}
            onChange={() => updateSetting('enabled', !settings.enabled)}
          />
          <span className="slider" />
        </div>
      </div>

      <div className={`control ${areFeatureTogglesDisabled ? 'is-disabled' : ''}`}>
        <label htmlFor="mute">MUTE</label>
        <div className="toggle">
          <input
            type="checkbox"
            id="mute"
            checked={settings.mute}
            disabled={areFeatureTogglesDisabled}
            onChange={() => updateSetting('mute', !settings.mute)}
          />
          <span className="slider" />
        </div>
      </div>

      <div className={`control ${areFeatureTogglesDisabled ? 'is-disabled' : ''}`}>
        <label htmlFor="warn">WARN</label>
        <div className="toggle">
          <input
            type="checkbox"
            id="warn"
            checked={settings.warn}
            disabled={areFeatureTogglesDisabled}
            onChange={() => updateSetting('warn', !settings.warn)}
          />
          <span className="slider" />
        </div>
      </div>

      <div className={`control timer-control ${isTimerDisabled ? 'is-disabled' : ''}`}>
        <label htmlFor="timer">TIMER</label>
        <div className={`range-container ${isTimerDisabled ? 'is-disabled' : ''}`}>
          <input
            ref={rangeRef}
            type="range"
            id="timer"
            min={MIN_TIMER}
            max={MAX_TIMER}
            value={settings.timer}
            disabled={isTimerDisabled}
            onChange={event => updateSetting('timer', Number(event.target.value))}
          />
          <div
            className={`range-value ${isTimerDisabled ? 'is-disabled' : ''}`}
            style={{ left: `${sliderLeft}px` }}
          >
            {settings.timer}
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
