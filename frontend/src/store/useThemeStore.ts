import { create } from 'zustand';

function applyDarkTheme() {
  document.documentElement.classList.add('dark');
}

interface ThemeState {
  theme: 'dark';
  init: () => void;
}

export const useThemeStore = create<ThemeState>(() => ({
  theme: 'dark',
  init: () => {
    applyDarkTheme();
  },
}));