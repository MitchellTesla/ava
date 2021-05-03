import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import workerThreads from 'worker_threads';

import globby from 'globby';
import proxyquire from 'proxyquire';
import replaceString from 'replace-string';

import {normalizeGlobs} from '../../lib/globs.js';
import pkg from '../../lib/pkg.cjs';
import providerManager from '../../lib/provider-manager.js';

const workerFile = fileURLToPath(new URL('report-worker.cjs', import.meta.url));

class Worker extends workerThreads.Worker {
	constructor(filename, options) {
		super(workerFile, {
			...options,
			env: {
				...options.env,
				NODE_NO_WARNINGS: '1'
			}
		});
	}
}

let _Api = null;
const createApi = options => {
	if (!_Api) {
		_Api = proxyquire('../../lib/api', {
			'./fork': proxyquire('../../lib/fork', {
				worker_threads: { // eslint-disable-line camelcase
					...workerThreads,
					Worker
				},
				child_process: { // eslint-disable-line camelcase
					...childProcess,
					fork(filename, argv, options) {
						return childProcess.fork(workerFile, argv, {
							...options,
							env: {
								...options.env,
								NODE_NO_WARNINGS: '1'
							}
						});
					}
				}
			})
		});
	}

	options.workerThreads = false;
	return new _Api(options);
};

const exports = {};
export default exports;

exports.assert = (t, logFile, buffer) => {
	let existing = null;
	try {
		existing = fs.readFileSync(logFile);
	} catch {}

	if (existing === null || process.env.UPDATE_REPORTER_LOG) {
		fs.writeFileSync(logFile, buffer);
		existing = buffer;
	}

	const expected = existing.toString('utf8');
	const actual = buffer.toString('utf8');
	if (actual === expected) {
		t.pass();
	} else {
		// Log the entire actual and expected values, so they can be diffed
		// manually. TAP's diff output is really confusing in this situation.
		console.dir({actual, expected});
		t.fail(`Output did not match expectation: ${logFile}`);
	}
};

exports.sanitizers = {
	cwd: string => replaceString(string, process.cwd(), '~'),
	experimentalWarning: string => string.replace(/^\(node:\d+\) ExperimentalWarning.+\n/g, ''),
	lineEndings: string => replaceString(string, '\r\n', '\n'),
	posix: string => replaceString(string, '\\', '/'),
	timers: string => string.replace(/timers\.js:\d+:\d+/g, 'timers.cjs'),
	version: string => replaceString(string, `v${pkg.version}`, 'v1.0.0-beta.5.1')
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));
exports.projectDir = type => path.join(__dirname, '../fixture/report', type.toLowerCase());

const run = (type, reporter, {match = [], filter} = {}) => {
	const projectDir = exports.projectDir(type);

	const providers = [{
		type: 'babel',
		level: 'ava-3',
		main: providerManager.babel(projectDir).main({
			config: {
				testOptions: {
					plugins: ['@babel/plugin-proposal-do-expressions']
				}
			}
		})
	}];

	const options = {
		extensions: ['js'],
		failFast: type === 'failFast' || type === 'failFast2',
		failWithoutAssertions: false,
		serial: type === 'failFast' || type === 'failFast2',
		require: [],
		cacheEnabled: false,
		experiments: {},
		match,
		providers,
		projectDir,
		timeout: type.startsWith('timeout') ? '10s' : undefined,
		concurrency: 1,
		updateSnapshots: false,
		snapshotDir: false,
		chalkOptions: {level: 1}
	};

	options.globs = normalizeGlobs({extensions: options.extensions, files: ['*'], providers: []});

	const api = createApi(options);
	api.on('run', plan => reporter.startRun(plan));

	const files = globby.sync('*.cjs', {
		absolute: true,
		brace: true,
		case: false,
		cwd: projectDir,
		dot: false,
		expandDirectories: false,
		extglob: true,
		followSymlinkedDirectories: true,
		gitignore: false,
		globstar: true,
		matchBase: false,
		onlyFiles: true,
		stats: false,
		unique: true
	}).sort();
	if (type !== 'watch') {
		return api.run({files, filter}).then(() => {
			reporter.endRun();
		});
	}

	// Mimick watch mode
	return api.run({files, filter, runtimeOptions: {clearLogOnNextRun: false, previousFailures: 0, runVector: 1}}).then(() => {
		reporter.endRun();
		return api.run({files, filter, runtimeOptions: {clearLogOnNextRun: true, previousFailures: 2, runVector: 2}});
	}).then(() => {
		reporter.endRun();
		return api.run({files, filter, runtimeOptions: {clearLogOnNextRun: false, previousFailures: 0, runVector: 3}});
	}).then(() => {
		reporter.endRun();
	});
};

exports.regular = reporter => run('regular', reporter);
exports.failFast = reporter => run('failFast', reporter);
exports.failFast2 = reporter => run('failFast2', reporter);
exports.only = reporter => run('only', reporter);
exports.timeoutInSingleFile = reporter => run('timeoutInSingleFile', reporter);
exports.timeoutInMultipleFiles = reporter => run('timeoutInMultipleFiles', reporter);
exports.timeoutWithMatch = reporter => run('timeoutWithMatch', reporter, {match: ['*needle*']});
exports.watch = reporter => run('watch', reporter);
exports.edgeCases = reporter => run('edgeCases', reporter, {
	filter: [
		{pattern: '**/*'},
		{pattern: '**/test.cjs', lineNumbers: [2]},
		{pattern: '**/ast-syntax-error.cjs', lineNumbers: [7]}
	]
});
