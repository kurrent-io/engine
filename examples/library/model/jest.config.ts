import type { Config } from 'jest';

const config: Config = {
  transform: {
    '\\.ts$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  testMatch: ['**/*.test.ts'],
};

export default config;
