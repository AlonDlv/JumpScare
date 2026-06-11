export const MIN_TIMER = 3;
export const MAX_TIMER = 10;

export type ExtensionSettings = {
  enabled: boolean;
  warn: boolean;
  mute: boolean;
  blur: boolean;
  timer: number;
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  warn: false,
  mute: false,
  blur: false,
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

function normalizeEnabled(value: unknown): boolean {
  return typeof value === "boolean" ? value : DEFAULT_SETTINGS.enabled;
}

function normalizeSettings(
  settings: Partial<ExtensionSettings> | null | undefined
): ExtensionSettings {
  return {
    enabled: normalizeEnabled(settings?.enabled),
    warn: Boolean(settings?.warn),
    mute: Boolean(settings?.mute),
    blur: Boolean(settings?.blur),
    timer: normalizeTimer(settings?.timer)
  };
}

function readLocalFallback(): ExtensionSettings {
  return normalizeSettings({
    enabled: JSON.parse(localStorage.getItem("enabled") ?? "true"),
    warn: JSON.parse(localStorage.getItem("warn") ?? "false"),
    mute: JSON.parse(localStorage.getItem("mute") ?? "false"),
    blur: JSON.parse(localStorage.getItem("blur") ?? "false"),
    timer: localStorage.getItem("timer")
  });
}

function writeLocalFallback(settings: ExtensionSettings): void {
  localStorage.setItem("enabled", JSON.stringify(settings.enabled));
  localStorage.setItem("warn", JSON.stringify(settings.warn));
  localStorage.setItem("mute", JSON.stringify(settings.mute));
  localStorage.setItem("blur", JSON.stringify(settings.blur));
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
