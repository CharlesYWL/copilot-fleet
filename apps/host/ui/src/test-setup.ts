import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing Library only registers this for itself when the test globals are on,
// and they are not; without it each render stacks onto the previous document.
afterEach(cleanup);
