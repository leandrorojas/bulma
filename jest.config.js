module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  coverageReporters: ["lcov", "text"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.test.ts", "!src/cli.ts"],
};
