import { describe, expect, test } from "vitest";
import { Parser, DataFactory } from "n3";
import { pred } from "rdf-lens";
import { createLogger } from "winston";
import type { Quad } from "@rdfjs/types";
import { ThresholdMonitor, ThresholdMonitorSDS } from "../src/index.js";
import { createChannel } from "./testUtils.js";

const logger = createLogger({ transports: [], silent: true });

const { namedNode } = DataFactory;

const TEMP = namedNode("http://example.org/ns#temperature");
const MEASUREMENT = namedNode("http://example.org/ns#Measurement");
const STREAM = namedNode("http://example.org/ns#stream1");
const SDS_GRAPH = "https://w3id.org/sds#DataDescription";
const CREATOR = namedNode("http://example.org/agents#threshold-monitor");

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const OSLC_ERROR = "http://open-services.net/ns/core#Error";
const DCT_REFERENCES = "http://purl.org/dc/terms/references";

/** An SDS record pointing at a member carrying a temperature. */
function sdsMessage(memberId: string, temperature: number, stream: string = STREAM.value): string {
    return `
<urn:record> <https://w3id.org/sds#payload> <${memberId}> <${SDS_GRAPH}>.
<urn:record> <https://w3id.org/sds#stream> <${stream}> <${SDS_GRAPH}>.
${measurement(memberId, temperature)}
`;
}

/** A bare measurement entity, without any SDS envelope. */
function measurement(id: string, temperature: number, type: string = MEASUREMENT.value): string {
    return `
<${id}> <${RDF_TYPE}> <${type}>.
<${id}> <http://example.org/ns#temperature> "${temperature}"^^<http://www.w3.org/2001/XMLSchema#double>.
`;
}

/**
 * `init()` and `transform()` are declared with a `this: Args & this` contract
 * that only the runner satisfies structurally, so call them through these
 * helpers rather than sprinkling casts over every test.
 */
type Runnable = { init(): Promise<void>; transform(): Promise<void> };

function init(monitor: Runnable): Promise<void> {
    return monitor.init();
}

/** Feed `messages` through the monitor and collect everything it writes out. */
async function run(
    monitor: Runnable,
    input: { string(msg: string): Promise<void>; close(): Promise<void> },
    output: { strings(): AsyncIterable<string>; cancel(): Promise<void> },
    messages: string[],
): Promise<string[]> {
    await init(monitor);
    const transformPromise = monitor.transform();

    const collected: string[] = [];
    const readPromise = (async () => {
        for await (const msg of output.strings()) {
            collected.push(msg);
        }
    })();

    for (const msg of messages) {
        await input.string(msg);
    }
    await input.close();

    await transformPromise;
    await output.cancel();
    await readPromise;

    return collected;
}

/** The entities the alerts in `msg` refer to, in order. */
function referencedEntities(msg: string): string[] {
    const quads = new Parser().parse(msg);
    return quads.filter((q) => q.predicate.value === DCT_REFERENCES).map((q) => q.object.value);
}

function isErrorAlert(quads: Quad[]): boolean {
    return quads.some((q) => q.predicate.value === RDF_TYPE && q.object.value === OSLC_ERROR);
}

describe("ThresholdMonitorSDS", () => {
    test("emits an alert only when the value exceeds the configured bounds", async () => {
        const [inputWriter, inputReader] = createChannel("in");
        const [outputWriter, outputReader] = createChannel("out");

        const proc = new ThresholdMonitorSDS(
            {
                reader: inputReader,
                writer: outputWriter,
                path: pred(TEMP),
                min: 10,
                max: 30,
                creator: CREATOR,
                label: "monitored value",
            },
            logger,
        );

        const collected = await run(proc, inputWriter, outputReader, [
            sdsMessage("http://example.org/m1", 5), // below min
            sdsMessage("http://example.org/m2", 20), // within bounds
            sdsMessage("http://example.org/m3", 35), // above max
        ]);

        expect(collected.length).toBe(2);

        const parser = new Parser();
        const firstAlert = parser.parse(collected[0]);
        expect(isErrorAlert(firstAlert)).toBe(true);
        expect(
            firstAlert.some(
                (q) =>
                    q.predicate.value === DCT_REFERENCES &&
                    q.object.value === "http://example.org/m1",
            ),
        ).toBe(true);
        expect(
            firstAlert.some(
                (q) =>
                    q.predicate.value === "http://purl.org/dc/terms/creator" &&
                    q.object.value === CREATOR.value,
            ),
        ).toBe(true);
        expect(
            firstAlert.some(
                (q) =>
                    q.predicate.value === "http://open-services.net/ns/core#message" &&
                    q.object.termType === "Literal",
            ),
        ).toBe(true);
        expect(
            firstAlert.some(
                (q) =>
                    q.predicate.value === "http://purl.org/dc/terms/created" &&
                    q.object.termType === "Literal" &&
                    (<{ datatype?: { value: string } }>q.object).datatype?.value ===
                        "http://www.w3.org/2001/XMLSchema#dateTime",
            ),
        ).toBe(true);

        expect(referencedEntities(collected[1])).toEqual(["http://example.org/m3"]);
    });

    test("only monitors records of the configured stream", async () => {
        const [inputWriter, inputReader] = createChannel("in");
        const [outputWriter, outputReader] = createChannel("out");

        const proc = new ThresholdMonitorSDS(
            {
                reader: inputReader,
                writer: outputWriter,
                path: pred(TEMP),
                max: 30,
                streamId: STREAM,
                creator: CREATOR,
                label: "monitored value",
            },
            logger,
        );

        const collected = await run(proc, inputWriter, outputReader, [
            sdsMessage("http://example.org/m1", 35, "http://example.org/ns#otherStream"),
            sdsMessage("http://example.org/m2", 35),
        ]);

        expect(collected.length).toBe(1);
        expect(referencedEntities(collected[0])).toEqual(["http://example.org/m2"]);
    });

    test("requires at least one of min or max to be configured", async () => {
        const [, inputReader] = createChannel("in");
        const [outputWriter] = createChannel("out");

        const proc = new ThresholdMonitorSDS(
            {
                reader: inputReader,
                writer: outputWriter,
                path: pred(TEMP),
                creator: CREATOR,
                label: "monitored value",
            },
            logger,
        );

        await expect(init(proc)).rejects.toThrow();
    });
});

describe("ThresholdMonitor", () => {
    test("alerts on out-of-bounds entities of the configured type, without any SDS envelope", async () => {
        const [inputWriter, inputReader] = createChannel("in");
        const [outputWriter, outputReader] = createChannel("out");

        const proc = new ThresholdMonitor(
            {
                reader: inputReader,
                writer: outputWriter,
                path: pred(TEMP),
                type: MEASUREMENT,
                min: 10,
                max: 30,
                creator: CREATOR,
                label: "monitored value",
            },
            logger,
        );

        const collected = await run(proc, inputWriter, outputReader, [
            measurement("http://example.org/m1", 5), // below min
            measurement("http://example.org/m2", 20), // within bounds
            measurement("http://example.org/m3", 35), // above max
        ]);

        expect(collected.length).toBe(2);
        expect(isErrorAlert(new Parser().parse(collected[0]))).toBe(true);
        expect(referencedEntities(collected[0])).toEqual(["http://example.org/m1"]);
        expect(referencedEntities(collected[1])).toEqual(["http://example.org/m3"]);
    });

    test("checks every typed entity of a message and ignores the other ones", async () => {
        const [inputWriter, inputReader] = createChannel("in");
        const [outputWriter, outputReader] = createChannel("out");

        const proc = new ThresholdMonitor(
            {
                reader: inputReader,
                writer: outputWriter,
                path: pred(TEMP),
                type: MEASUREMENT,
                max: 30,
                creator: CREATOR,
                label: "monitored value",
            },
            logger,
        );

        const collected = await run(proc, inputWriter, outputReader, [
            measurement("http://example.org/m1", 35) +
                measurement("http://example.org/m2", 40) +
                // Not a measurement, so never monitored, however high it goes.
                measurement("http://example.org/other", 50, "http://example.org/ns#Other"),
        ]);

        expect(collected.length).toBe(1);
        expect(referencedEntities(collected[0])).toEqual([
            "http://example.org/m1",
            "http://example.org/m2",
        ]);
    });

    test("writes nothing when a message holds no entity of the configured type", async () => {
        const [inputWriter, inputReader] = createChannel("in");
        const [outputWriter, outputReader] = createChannel("out");

        const proc = new ThresholdMonitor(
            {
                reader: inputReader,
                writer: outputWriter,
                path: pred(TEMP),
                type: MEASUREMENT,
                max: 30,
                creator: CREATOR,
                label: "monitored value",
            },
            logger,
        );

        const collected = await run(proc, inputWriter, outputReader, [
            measurement("http://example.org/other", 50, "http://example.org/ns#Other"),
        ]);

        expect(collected).toEqual([]);
    });

    test("skips values that are not numeric literals", async () => {
        const [inputWriter, inputReader] = createChannel("in");
        const [outputWriter, outputReader] = createChannel("out");

        const proc = new ThresholdMonitor(
            {
                reader: inputReader,
                writer: outputWriter,
                path: pred(TEMP),
                type: MEASUREMENT,
                max: 30,
                creator: CREATOR,
                label: "monitored value",
            },
            logger,
        );

        const collected = await run(proc, inputWriter, outputReader, [
            `<http://example.org/m1> <${RDF_TYPE}> <${MEASUREMENT.value}>.
             <http://example.org/m1> <${TEMP.value}> "warm".
             <http://example.org/m2> <${RDF_TYPE}> <${MEASUREMENT.value}>.
             <http://example.org/m2> <${TEMP.value}> <http://example.org/ns#hot>.`,
        ]);

        expect(collected).toEqual([]);
    });

    test("alerts once for an entity that carries the configured type twice", async () => {
        const [inputWriter, inputReader] = createChannel("in");
        const [outputWriter, outputReader] = createChannel("out");

        const proc = new ThresholdMonitor(
            {
                reader: inputReader,
                writer: outputWriter,
                path: pred(TEMP),
                type: MEASUREMENT,
                max: 30,
                creator: CREATOR,
                label: "monitored value",
            },
            logger,
        );

        const collected = await run(proc, inputWriter, outputReader, [
            measurement("http://example.org/m1", 35) +
                `<http://example.org/m1> <${RDF_TYPE}> <${MEASUREMENT.value}> <http://example.org/ns#otherGraph>.`,
        ]);

        expect(collected.length).toBe(1);
        expect(referencedEntities(collected[0])).toEqual(["http://example.org/m1"]);
    });

    test("requires at least one of min or max to be configured", async () => {
        const [, inputReader] = createChannel("in");
        const [outputWriter] = createChannel("out");

        const proc = new ThresholdMonitor(
            {
                reader: inputReader,
                writer: outputWriter,
                path: pred(TEMP),
                type: MEASUREMENT,
                creator: CREATOR,
                label: "monitored value",
            },
            logger,
        );

        await expect(init(proc)).rejects.toThrow();
    });
});
