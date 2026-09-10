import '@testing-library/jest-dom';

(globalThis as any).import = {
  meta: {
    env: {
      VITE_API_URL: 'http://localhost:3000/api',
    },
  },
};
