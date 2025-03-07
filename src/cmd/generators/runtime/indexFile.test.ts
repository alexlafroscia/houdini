// external imports
import path from 'path'
import fs from 'fs/promises'
import * as typeScriptParser from 'recast/parsers/typescript'
import { ProgramKind } from 'ast-types/gen/kinds'
import * as recast from 'recast'
// local imports
import { testConfig } from '../../../common'
import '../../../../jest.setup'
import { runPipeline } from '../../generate'
import { CollectedGraphQLDocument } from '../../types'
import { mockCollectedDoc } from '../../testUtils'

// the documents to test
const docs: CollectedGraphQLDocument[] = [
	mockCollectedDoc(`query TestQuery { version }`),
	mockCollectedDoc(`fragment TestFragment on User { firstName }`),
]

test('runtime index file - sapper', async function () {
	const config = testConfig({ module: 'commonjs', framework: 'sapper' })
	// execute the generator
	await runPipeline(config, docs)

	// open up the index file
	const queryContents = await fs.readFile(path.join(config.rootDir, 'index.js'), 'utf-8')
	expect(queryContents).toBeTruthy()
	// parse the contents
	const parsedQuery: ProgramKind = recast.parse(queryContents, {
		parser: typeScriptParser,
	}).program
	// verify contents
	expect(parsedQuery).toMatchInlineSnapshot(`
		"use strict";
		var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
		    if (k2 === undefined) k2 = k;
		    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
		}) : (function(o, m, k, k2) {
		    if (k2 === undefined) k2 = k;
		    o[k2] = m[k];
		}));
		var __exportStar = (this && this.__exportStar) || function(m, exports) {
		    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
		};
		var __importDefault = (this && this.__importDefault) || function (mod) {
		    return (mod && mod.__esModule) ? mod : { "default": mod };
		};
		Object.defineProperty(exports, "__esModule", { value: true });

		var houdiniConfig = require("../../../config.cjs");
		Object.defineProperty(exports, "houdiniConfig", { enumerable: true, get: function () { return __importDefault(houdiniConfig).default; } });

		__exportStar(require("./runtime"), exports);
		__exportStar(require("./artifacts"), exports);
	`)
})

test('runtime index file - kit', async function () {
	const config = testConfig({ module: 'esm', framework: 'kit' })
	// execute the generator
	await runPipeline(config, docs)

	// open up the index file
	const queryContents = await fs.readFile(path.join(config.rootDir, 'index.js'), 'utf-8')
	expect(queryContents).toBeTruthy()
	// parse the contents
	const parsedQuery: ProgramKind = recast.parse(queryContents, {
		parser: typeScriptParser,
	}).program
	// verify contents
	expect(parsedQuery).toMatchInlineSnapshot(`
		export { default as houdiniConfig } from "../config.cjs"
		export * from "./runtime"
		export * from "./artifacts"
	`)
})
