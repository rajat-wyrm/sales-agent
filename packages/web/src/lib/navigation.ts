// One-line seam so tests can mock the post-auth-failure redirect: since
// jsdom 26 (jest-environment-jsdom 30) window.location is [LegacyUnforgeable]
// and can no longer be redefined or spied on from a test.
export const navigateToLogin = () => {
  window.location.href = '/login';
};
