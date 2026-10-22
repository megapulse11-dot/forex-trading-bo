import { ParsingContext, Refiner } from "../../../chrono";
import { ParsingResult } from "../../../results";
export default class ENEndOfPeriodRefiner implements Refiner {
    refine(context: ParsingContext, results: ParsingResult[]): ParsingResult[];
    private moveToEndOfRelativePeriod;
    private moveToEndOfMonth;
}
