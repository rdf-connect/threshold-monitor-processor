# Threshold Monitor Processor

[RDF-Connect](https://github.com/rdf-connect) processors that watch a numeric
value on incoming RDF messages and emit an `oslc:Error` report whenever that
value falls outside a configured `[min, max]` range.

Two flavours are shipped, differing only in how the entities to monitor are
found in an incoming message:

| Processor                | Input                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `tm:ThresholdMonitorJs`    | Plain RDF. Every entity typed with the configured `tm:type` is monitored.                  |
| `tm:ThresholdMonitorSDSJs` | [SDS](https://w3id.org/sds#) records. The member of each record's `sds:payload` is monitored, optionally restricted to one `sds:stream`. |

For each measurement found in a message, both processors:

1. Extract a value from that entity using a configured SHACL path.
2. If the value is a number and violates the configured `min`/`max` bound, write
   a small `oslc:Error` graph to their `writer`, ready to be inserted into an
   error graph (e.g. by a [mu-semtech](https://mu.semte.ch/) error-reporting
   service).

Messages that don't violate any bound produce no output — the processors are a
filter/enricher, not a pass-through.

## Installation

```bash
npm install @rdfc/threshold-monitor-processor-ts
```

Then import `processor.ttl` from this package into your pipeline (see
[Configuring the processor](#configuring-the-processor) below) and reference
`tm:ThresholdMonitorJs` or `tm:ThresholdMonitorSDSJs` as a processor instance.

## Configuring the processor

Both processors are described in [`processor.ttl`](./processor.ttl), under the
namespace `https://w3id.org/rdf-connect/threshold-monitor#` (prefix `tm:`). An
instance takes the following parameters:

| Parameter    | Predicate    | Required          | Type             | Description                                                                                                     |
| ------------ | ------------ | ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `reader`     | `rdfc:reader`  | yes                | `rdfc:Reader`      | Channel to read incoming messages (N-Quads strings) from.                                                        |
| `writer`     | `rdfc:writer`  | yes                | `rdfc:Writer`      | Channel to write generated alert messages to.                                                                    |
| `path`       | `tm:path`      | yes                | SHACL property path | Path, relative to the monitored entity's IRI, used to extract the value to monitor. Any SHACL path expression rdf-lens supports works (single predicate, sequence, inverse, etc). |
| `min`        | `tm:min`       | no<sup>†</sup>       | `xsd:double`      | Lower bound. Values strictly below `min` trigger an alert.                                                       |
| `max`        | `tm:max`       | no<sup>†</sup>       | `xsd:double`      | Upper bound. Values strictly above `max` trigger an alert.                                                       |
| `label`      | `rdfs:label`   | no                 | `xsd:string`      | Human-readable name used in log output and in the generated error's message/detail. |
| `creator`    | `tm:creator`   | yes                | IRI               | Agent the generated error is attributed to (`dct:creator`).                                                      |

† At least one of `min` or `max` must be set — `init()` throws if both are
omitted. Setting only one leaves the other side of the range unchecked (e.g.
configuring only `max` never flags values that are too low).

On top of those, each processor takes one parameter of its own:

| Processor                | Parameter  | Predicate   | Required | Type | Description                                                                                                     |
| ------------------------ | ---------- | ----------- | -------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| `tm:ThresholdMonitorJs`    | `type`     | `tm:type`   | yes      | IRI  | Only entities with this `rdf:type` are monitored. Every matching entity in a message is checked.                 |
| `tm:ThresholdMonitorSDSJs` | `streamId` | `tm:stream` | no       | IRI  | Restrict monitoring to records whose `sds:stream` equals this IRI. If omitted, every incoming record is checked. |

### Example pipeline

```turtle
@prefix rdfc: <https://w3id.org/rdf-connect#>.
@prefix tm:   <https://w3id.org/rdf-connect/threshold-monitor#>.
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix ex:   <http://example.org/ns#>.

<> a rdfc:Pipeline;
    rdfc:consistsOf [
        rdfc:processor <#TemperatureMonitor>, <#SDSTemperatureMonitor>;
    ].

<data-in> a rdfc:Channel.
<sds-in>  a rdfc:Channel.
<alerts-out> a rdfc:Channel.

<#TemperatureMonitor> a tm:ThresholdMonitorJs;
    rdfc:reader <data-in>;
    rdfc:writer <alerts-out>;
    tm:type ex:Measurement;
    tm:path ex:temperature;
    tm:min "10.0"^^xsd:double;
    tm:max "30.0"^^xsd:double;
    tm:creator <http://example.org/agents#threshold-monitor>;
    rdfs:label "temperature sensor".

<#SDSTemperatureMonitor> a tm:ThresholdMonitorSDSJs;
    rdfc:reader <sds-in>;
    rdfc:writer <alerts-out>;
    tm:path ex:temperature;
    tm:min "10.0"^^xsd:double;
    tm:max "30.0"^^xsd:double;
    tm:stream ex:temperatureStream;
    tm:creator <http://example.org/agents#threshold-monitor>;
    rdfs:label "temperature sensor".
```

`data-in` carries plain RDF messages describing `ex:Measurement` entities, while
`sds-in` is expected to carry SDS records (typically produced by an
`sds-processors` `sdsify`/`bucketize` step or similar). `alerts-out` can be fed
into any downstream processor (e.g. a SPARQL-inserting sink) to act on the
generated `oslc:Error` reports.

## Alert output

Each violation is written to `writer` as a standalone N-Quads/Turtle string
containing a blank-node subject conforming to the `ex:ErrorShape` SHACL shape
defined in [`processor.ttl`](./processor.ttl), with:

| Predicate            | Value                                                                     |
| --------------------- | ---------------------------------------------------------------------------- |
| `rdf:type`             | `oslc:Error`                                                                |
| `mu:uuid`              | a freshly generated UUID for the error                                     |
| `dct:subject`          | the fixed string `"threshold-monitor"`, the service that raised the error   |
| `oslc:message`         | a generated short description of the violation                            |
| `dct:created`          | an `xsd:dateTime` timestamp of when the violation was observed             |
| `dct:creator`          | the configured `creator` IRI                                                |
| `oslc:largePreview`    | a generated detail describing the entity, value, and violated bound        |
| `dct:references`       | IRI of the entity that violated the bound                                  |

This shape is designed to be insertable directly into an error graph, e.g.:

```sparql
PREFIX oslc: <http://open-services.net/ns/core#>
PREFIX mu:   <http://mu.semte.ch/vocabularies/core/>
PREFIX dct:  <http://purl.org/dc/terms/>

INSERT DATA {
  GRAPH <http://mu.semte.ch/graphs/errors> {
    <http://example.org/errors/1> a oslc:Error;
        mu:uuid "…";
        dct:subject "threshold-monitor";
        oslc:message "…";
        dct:created "2026-07-15T09:21:45.725Z"^^xsd:dateTime;
        dct:creator <http://example.org/agents#threshold-monitor>;
        oslc:largePreview "…";
        dct:references <http://example.org/m1> .
  }
}
```

Values found at the configured path that aren't literals, or aren't parseable
as numbers, are skipped with a warning log rather than raising an error.

## Development

```bash
npm install
npm run build   # compiles src/ to lib/
npm test        # runs the vitest suite with coverage
```

## License

MIT
