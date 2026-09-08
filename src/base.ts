import { randomUUID } from "node:crypto";
import { Processor, type Reader, type Writer } from "@rdfc/js-runner";
import { Parser, Writer as N3Writer, DataFactory } from "n3";
import { RDF, XSD, createUriAndTermNamespace } from "@treecg/types";
import type { BasicLensM, Cont } from "rdf-lens";
import type { Quad, Term } from "@rdfjs/types";

const { literal, quad, blankNode } = DataFactory;

/** Open Services for Lifecycle Collaboration core vocabulary. */
export const OSLC = createUriAndTermNamespace(
    "http://open-services.net/ns/core#",
    "Error",
    "message",
    "largePreview",
);

/** mu.semte.ch core vocabulary. */
export const MU = createUriAndTermNamespace("http://mu.semte.ch/vocabularies/core/", "uuid");

/** Dublin Core terms vocabulary. */
export const DCT = createUriAndTermNamespace(
    "http://purl.org/dc/terms/",
    "subject",
    "created",
    "creator",
    "references",
);

/** Name reported as the failing service (`dct:subject`) on every generated error. */
const SERVICE_NAME = "threshold-monitor";

/** Arguments shared by every threshold monitor flavour. */
export type ThresholdMonitorArgs = {
    reader: Reader;
    writer: Writer;
    path: BasicLensM<Cont, Cont>;
    min?: number;
    max?: number;
    label?: string;
    creator: Term;
};

/**
 * Shared behaviour of the threshold monitors: for every message read from
 * `reader`, each measurement it contains is resolved through the configured
 * SHACL path and, when the resulting value falls outside the configured
 * [min, max] bounds, an `oslc:Error` alert graph is written to `writer`.
 *
 * Subclasses only decide _which_ entities of an incoming message are the
 * measurements to check; see {@link ThresholdMonitorBase.findMeasurements}.
 */
export abstract class ThresholdMonitorBase<
    Args extends ThresholdMonitorArgs,
> extends Processor<Args> {
    async init(this: Args & this): Promise<void> {
        if (this.min === undefined && this.max === undefined) {
            throw new Error(
                `${this.constructor.name} requires at least one of \`min\` or \`max\` to be configured`,
            );
        }

        const bounds = [
            this.min !== undefined ? `>= ${this.min}` : undefined,
            this.max !== undefined ? `<= ${this.max}` : undefined,
        ]
            .filter((x) => x !== undefined)
            .join(" and ");

        this.logger.info(
            `${this.constructor.name} watching${this.label ? ` '${this.label}'` : ""}, expecting values ${bounds}`,
        );
    }

    async transform(this: Args & this): Promise<void> {
        const parser = new Parser();

        for await (const msg of this.reader.strings()) {
            const quads = parser.parse(msg);
            const alerts = this.findMeasurements(quads).flatMap((measurement) =>
                this.checkMeasurement(measurement),
            );

            if (alerts.length > 0) {
                await this.writer.string(new N3Writer().quadsToString(alerts));
            }
        }

        await this.writer.close();
        this.logger.debug(`${this.constructor.name} finished processing. Writer closed.`);
    }

    async produce(this: Args & this): Promise<void> {
        // This processor is purely reactive; it never initiates its own data.
    }

    /**
     * The measurements described by a single incoming message, as rdf-lens
     * containers: the entity to monitor together with the quads the configured
     * path is executed against.
     */
    protected abstract findMeasurements(this: Args & this, quads: Quad[]): Cont[];

    /** Alerts for every out-of-bounds value found at the configured path. */
    private checkMeasurement(this: Args & this, measurement: Cont): Quad[] {
        const entity = measurement.id;
        const alerts: Quad[] = [];

        for (const found of this.path.execute(measurement)) {
            if (found.id.termType !== "Literal") {
                this.logger.warn(
                    `Value found at configured path for member <${entity.value}> is not a literal, skipping.`,
                );
                continue;
            }

            const value = Number.parseFloat(found.id.value);
            if (Number.isNaN(value)) {
                this.logger.warn(
                    `Value '${found.id.value}' found at configured path for member <${entity.value}> is not a number, skipping.`,
                );
                continue;
            }

            if (this.min !== undefined && value < this.min) {
                alerts.push(...this.buildAlert(entity, value, "min", this.min));
            } else if (this.max !== undefined && value > this.max) {
                alerts.push(...this.buildAlert(entity, value, "max", this.max));
            }
        }

        return alerts;
    }

    private buildAlert(
        this: Args & this,
        member: Term,
        value: number,
        bound: "min" | "max",
        boundValue: number,
    ): Quad[] {
        const id = blankNode();
        const label = this.label ?? "monitored value";
        const violation =
            bound === "min"
                ? `below the minimum of ${boundValue}`
                : `above the maximum of ${boundValue}`;

        const message = `Threshold violation: ${label} ${violation}`;
        const detail =
            `${label} reported a value of ${value} for <${member.value}>, which is ${violation}.`;

        return [
            quad(id, RDF.terms.type, OSLC.terms.Error),
            quad(id, MU.terms.uuid, literal(randomUUID())),
            quad(id, DCT.terms.subject, literal(SERVICE_NAME)),
            quad(id, OSLC.terms.message, literal(message)),
            quad(id, DCT.terms.created, literal(new Date().toISOString(), XSD.terms.dateTime)),
            quad(id, DCT.terms.creator, <Quad["object"]>this.creator),
            quad(id, OSLC.terms.largePreview, literal(detail)),
            quad(id, DCT.terms.references, <Quad["object"]>member),
        ];
    }
}
