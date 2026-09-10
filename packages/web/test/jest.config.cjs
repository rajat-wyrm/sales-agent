module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  rootDir: '../',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.tsx', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.json',
      useESM: false,
    }],
  },
  transformIgnorePatterns: ['/node_modules/(?!@tanstack)'],
};
