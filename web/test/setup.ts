import { afterEach, beforeEach } from 'vitest';

// Each test starts with empty browser storage so identity and probe caches never leak between tests.
beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // storage may be unavailable in some environments
  }
});

afterEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // ignore
  }
});
