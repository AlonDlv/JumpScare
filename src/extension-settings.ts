export const MIN_TIMER = 3;
export const MAX_TIMER = 10;

export type ExtensionSettings = {
  warn: boolean;
  mute: boolean;
  skip: boolean;
  timer: number;
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  warn: false,
  mute: false,
  skip: false,
  timer: MIN_TIMER
};

const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as Array<
  keyof ExtensionSettings
>;

function hasChromeStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

function normalizeTimer(value: unknown): number {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return DEFAULT_SETTINGS.timer;
  }

  return Math.min(MAX_TIMER, Math.max(MIN_TIMER, numericValue));
}

function normalizeSettings(
  settings: Partial<ExtensionSettings> | null | undefined
): ExtensionSettings {
  return {
    warn: Boolean(settings?.warn),
    mute: Boolean(settings?.mute),
    skip: Boolean(settings?.skip),
    timer: normalizeTimer(settings?.timer)
  };
}

function readLocalFallback(): ExtensionSettings {
  return normalizeSettings({
    warn: JSON.parse(localStorage.getItem("warn") ?? "false"),
    mute: JSON.parse(localStorage.getItem("mute") ?? "false"),
    skip: JSON.parse(localStorage.getItem("skip") ?? "false"),
    timer: localStorage.getItem("timer")
  });
}

function writeLocalFallback(settings: ExtensionSettings): void {
  localStorage.setItem("warn", JSON.stringify(settings.warn));
  localStorage.setItem("mute", JSON.stringify(settings.mute));
  localStorage.setItem("skip", JSON.stringify(settings.skip));
  localStorage.setItem("timer", settings.timer.toString());
}

export function loadSettings(): Promise<ExtensionSettings> {
  if (!hasChromeStorage()) {
    return Promise.resolve(readLocalFallback());
  }

  return new Promise(resolve => {
    chrome.storage.local.get(DEFAULT_SETTINGS, items => {
      const settings = normalizeSettings(items as Partial<ExtensionSettings>);
      writeLocalFallback(settings);
      resolve(settings);
    });
  });
}

export async function saveSettings(
  partialSettings: Partial<ExtensionSettings>
): Promise<ExtensionSettings> {
  const currentSettings = await loadSettings();
  const nextSettings = normalizeSettings({
    ...currentSettings,
    ...partialSettings
  });

  writeLocalFallback(nextSettings);

  if (!hasChromeStorage()) {
    return nextSettings;
  }

  return new Promise(resolve => {
    chrome.storage.local.set(nextSettings, () => {
      resolve(nextSettings);
    });
  });
}

export function subscribeToSettings(
  listener: (settings: ExtensionSettings) => void
): () => void {
  if (!hasChromeStorage()) {
    return () => {};
  }

  const handleStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ) => {
    if (areaName !== "local") {
      return;
    }

    const relevantChange = SETTINGS_KEYS.some(key => key in changes);
    if (!relevantChange) {
      return;
    }

    void loadSettings().then(listener);
  };

  chrome.storage.onChanged.addListener(handleStorageChange);

  return () => {
    chrome.storage.onChanged.removeListener(handleStorageChange);
  };
}
