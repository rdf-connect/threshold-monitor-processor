import { SDS } from "@treecg/types";
import type { Cont } from "rdf-lens";
import type { Quad, Term } from "@rdfjs/types";
import { ThresholdMonitorBase, type ThresholdMonitorArgs } from "./base.js";

const DATA_DESCRIPTION_GRAPH = SDS.terms.custom("DataDescription");

export type ThresholdMonitorSDSArgs = ThresholdMonitorArgs & {
    streamId?: Term;
};

/**
 * ThresholdMonitorSDS reads a stream of SDS messages and monitors the member
 * each record points at with `sds:payload`, optionally restricted to a single
 * `sds:stream`.
 */
export class ThresholdMonitorSDS extends ThresholdMonitorBase<ThresholdMonitorSDSArgs> {
    protected findMeasurements(
        this: ThresholdMonitorSDSArgs & this,
        quads: Quad[],
    ): Cont[] {
        const memberQuads = quads.filter((q) => !q.graph.equals(DATA_DESCRIPTION_GRAPH));
        const records = quads.filter((q) => q.predicate.equals(SDS.terms.payload));

        return records
            .filter((record) => this.matchesStream(quads, record.subject))
            .map((record) => ({ id: record.object, quads: memberQuads }));
    }

    private matchesStream(
        this: ThresholdMonitorSDSArgs & this,
        quads: Quad[],
        record: Term,
    ): boolean {
        if (!this.streamId) {
            return true;
        }

        return quads.some(
            (q) =>
                q.subject.equals(record) &&
                q.predicate.equals(SDS.terms.stream) &&
                q.object.equals(this.streamId),
        );
    }
}
