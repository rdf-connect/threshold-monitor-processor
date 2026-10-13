import { describe, expect, test } from "vitest";
import { readFileSync } from "fs";
import { Parser, DataFactory } from "n3";
import { resolve } from "path";
import { checkShapes, extractShapes, empty } from "rdf-lens";
import { ProcHelper } from "@rdfc/js-runner/lib/testUtils";
import type { BasicLensM, Cont } from "rdf-lens";
import type { FullProc } from "@rdfc/js-runner";
import type { ThresholdMonitor, ThresholdMonitorSDS } from "../src/index.js";

const { namedNode } = DataFactory;

const RDFC_READER = "https://w3id.org/rdf-connect#Reader";
const RDFC_WRITER = "https://w3id.org/rdf-connect#Writer";
const TM = "https://w3id.org/rdf-connect/threshold-monitor#";

const PREFIXES = `
        @prefix tm: <${TM}>.
        @prefix rdfc: <https://w3id.org/rdf-connect#>.
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#>.
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
        `;

type MonitorArgs = {
    path: BasicLensM<Cont, Cont>;
    min: number;
    max: number;
    creator: { value: string };
};

/** Extract the processor arguments of `<http://example.com/ns#monitor>`. */
function extractArgs<T>(instance: string, targetClass: string): T {
    const shapeQuads = new Parser().parse(readFileSync(process.cwd() + "/processor.ttl", "utf-8"));
    const instanceQuads = new Parser({ baseIRI: "" }).parse(PREFIXES + instance);
    const quads = [...shapeQuads, ...instanceQuads];

    const shapes = extractShapes(
        quads,
        {},
        {
            [RDFC_READER]: empty<Cont>(),
            [RDFC_WRITER]: empty<Cont>(),
        },
    );

    const lens = shapes.lenses[targetClass];
    expect(lens).toBeDefined();

    return <T>lens.execute({
        id: namedNode("http://example.com/ns#monitor"),
        quads,
    });
}

/** The path lens is only useful if it actually resolves values on data. */
function expectWorkingPathLens(path: BasicLensM<Cont, Cont>) {
    const dataQuads = new Parser().parse(
        `<http://example.org/ns#member1> <http://example.org/ns#temperature> "42.5"^^<http://www.w3.org/2001/XMLSchema#double>.`,
    );
    const found = path.execute({
        id: namedNode("http://example.org/ns#member1"),
        quads: dataQuads,
    });

    expect(found.map((x) => x.id.value)).toEqual(["42.5"]);
}

describe("tm:ThresholdMonitorSDSJs processor definition", () => {
    test("the SHACL shape extracts a working path lens, typed bounds and the stream", () => {
        const args = extractArgs<MonitorArgs & { streamId: { value: string } }>(
            `
        <http://example.com/ns#monitor> a tm:ThresholdMonitorSDSJs;
          rdfc:reader <jr>;
          rdfc:writer <jw>;
          tm:path <http://example.org/ns#temperature>;
          tm:min "10.0"^^xsd:double;
          tm:max "30.0"^^xsd:double;
          tm:stream <http://example.org/ns#stream1>;
          tm:creator <http://example.org/agents#threshold-monitor>;
          rdfs:label "temperature sensor".
        `,
            TM + "ThresholdMonitorSDSJs",
        );

        expect(args.min).toBe(10);
        expect(args.max).toBe(30);
        expect(args.creator.value).toBe("http://example.org/agents#threshold-monitor");
        expect(args.streamId.value).toBe("http://example.org/ns#stream1");

        expectWorkingPathLens(args.path);
    });
});

describe("tm:ThresholdMonitorJs processor definition", () => {
    test("the SHACL shape extracts a working path lens, typed bounds and the monitored type", () => {
        const args = extractArgs<MonitorArgs & { type: { value: string } }>(
            `
        <http://example.com/ns#monitor> a tm:ThresholdMonitorJs;
          rdfc:reader <jr>;
          rdfc:writer <jw>;
          tm:path <http://example.org/ns#temperature>;
          tm:type <http://example.org/ns#Measurement>;
          tm:min "10.0"^^xsd:double;
          tm:max "30.0"^^xsd:double;
          tm:creator <http://example.org/agents#threshold-monitor>;
          rdfs:label "temperature sensor".
        `,
            TM + "ThresholdMonitorJs",
        );

        expect(args.min).toBe(10);
        expect(args.max).toBe(30);
        expect(args.creator.value).toBe("http://example.org/agents#threshold-monitor");
        expect(args.type.value).toBe("http://example.org/ns#Measurement");

        expectWorkingPathLens(args.path);
    });
});

describe("processor defaults", () => {
    test("tm:ThresholdMonitorSDSJs falls back to its default label", () => {
        const args = extractArgs<{ label: string; min?: number; streamId?: unknown }>(
            `
        <http://example.com/ns#monitor> a tm:ThresholdMonitorSDSJs;
          rdfc:reader <jr>;
          rdfc:writer <jw>;
          tm:path <http://example.org/ns#temperature>;
          tm:creator <http://example.org/agents#threshold-monitor>.
        `,
            TM + "ThresholdMonitorSDSJs",
        );

        expect(args.label).toBe("monitored value");
        expect(args.min).toBeUndefined();
        expect(args.streamId).toBeUndefined();
    });

    test("tm:ThresholdMonitorJs falls back to its default label", () => {
        const args = extractArgs<{ label: string; max?: number }>(
            `
        <http://example.com/ns#monitor> a tm:ThresholdMonitorJs;
          rdfc:reader <jr>;
          rdfc:writer <jw>;
          tm:path <http://example.org/ns#temperature>;
          tm:type <http://example.org/ns#Measurement>;
          tm:creator <http://example.org/agents#threshold-monitor>.
        `,
            TM + "ThresholdMonitorJs",
        );

        expect(args.label).toBe("monitored value");
        expect(args.max).toBeUndefined();
    });

    test("an explicit label overrides the default", () => {
        const args = extractArgs<{ label: string }>(
            `
        <http://example.com/ns#monitor> a tm:ThresholdMonitorJs;
          rdfc:reader <jr>;
          rdfc:writer <jw>;
          tm:path <http://example.org/ns#temperature>;
          tm:type <http://example.org/ns#Measurement>;
          tm:min "10.0"^^xsd:double;
          tm:creator <http://example.org/agents#threshold-monitor>;
          rdfs:label "temperature sensor".
        `,
            TM + "ThresholdMonitorJs",
        );

        expect(args.label).toBe("temperature sensor");
    });
});

describe("IRI arguments", () => {
    const instances = `
        @prefix tm: <${TM}>.
        @prefix rdfc: <https://w3id.org/rdf-connect#>.

        <http://example.com/ns#sds> a tm:ThresholdMonitorSDSJs;
          rdfc:reader <jr>;
          rdfc:writer <jw>;
          tm:path <http://example.org/ns#temperature>;
          tm:stream <http://example.org/ns#stream1>;
          tm:creator <http://example.org/agents#threshold-monitor>.

        <http://example.com/ns#entity> a tm:ThresholdMonitorJs;
          rdfc:reader <jr>;
          rdfc:writer <jw>;
          tm:path <http://example.org/ns#temperature>;
          tm:type <http://example.org/ns#Measurement>;
          tm:creator <http://example.org/agents#threshold-monitor>.
        `;

    test("the shapes and IRI-valued instances check without findings", () => {
        const quads = [
            ...new Parser().parse(readFileSync(process.cwd() + "/processor.ttl", "utf-8")),
            ...new Parser({ baseIRI: "" }).parse(instances),
        ];

        expect(checkShapes(quads).findings).toEqual([]);
    });

    test("the processors receive the IRIs as terms", async () => {
        const helper = new ProcHelper<ThresholdMonitorSDS | ThresholdMonitor>();
        await helper.importFile(resolve("./processor.ttl"));
        await helper.importInline(resolve("./pipeline.ttl"), instances);

        helper.getConfig(namedNode(TM + "ThresholdMonitorSDSJs"));
        const sds = <FullProc<ThresholdMonitorSDS>>(
            await helper.getProcessor("http://example.com/ns#sds")
        );
        expect(sds.creator.termType).toBe("NamedNode");
        expect(sds.creator.value).toBe("http://example.org/agents#threshold-monitor");
        expect(sds.streamId?.termType).toBe("NamedNode");
        expect(sds.streamId?.value).toBe("http://example.org/ns#stream1");

        helper.getConfig(namedNode(TM + "ThresholdMonitorJs"));
        const entity = <FullProc<ThresholdMonitor>>(
            await helper.getProcessor("http://example.com/ns#entity")
        );
        expect(entity.creator.termType).toBe("NamedNode");
        expect(entity.creator.value).toBe("http://example.org/agents#threshold-monitor");
        expect(entity.type.termType).toBe("NamedNode");
        expect(entity.type.value).toBe("http://example.org/ns#Measurement");
    });
});
