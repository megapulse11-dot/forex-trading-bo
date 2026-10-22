import { ParsingContext, Refiner } from "../../../chrono.js";
import { ParsingResult } from "../../../results.js";
export default class ENEndOfPeriodRefiner implements Refiner {
    refine(context: ParsingContext, results: ParsingResult[]): ParsingResult[];
    private moveToEndOfRelativePeriod;
    private moveToEndOfMonth;
}
