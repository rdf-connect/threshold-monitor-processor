import { RDF } from "@treecg/types";
import type { Cont } from "rdf-lens";
import type { Quad, Term } from "@rdfjs/types";
import { ThresholdMonitorBase, type ThresholdMonitorArgs } from "./base.js";

export type ThresholdMonitorEntityArgs = ThresholdMonitorArgs & {
    type: Term;
};

/**
 * ThresholdMonitor reads plain RDF messages — no SDS envelope required — and
 * monitors every entity in them that is typed with the configured `type`.
 */
export class ThresholdMonitor extends ThresholdMonitorBase<ThresholdMonitorEntityArgs> {
    protected findMeasurements(
        this: ThresholdMonitorEntityArgs & this,
        quads: Quad[],
    ): Cont[] {
        const seen = new Set<string>();
        const measurements: Cont[] = [];

        for (const q of quads) {
            if (!q.predicate.equals(RDF.terms.type) || !q.object.equals(this.type)) {
                continue;
            }

            const key = `${q.subject.termType} ${q.subject.value}`;
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            measurements.push({ id: q.subject, quads });
        }

        if (measurements.length === 0) {
            this.logger.debug(`No entities of type <${this.type.value}> found in message.`);
        }

        return measurements;
    }
}
