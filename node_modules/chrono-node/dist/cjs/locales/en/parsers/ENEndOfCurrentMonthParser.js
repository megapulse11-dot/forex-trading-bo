"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const PATTERN = /(?:last\s+day|end)\s+of\s+(?:the\s+)?month(?=\W|$)/i;
class ENEndOfCurrentMonthParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return PATTERN;
    }
    innerExtract(context) {
        const targetDate = context.reference.getDateWithAdjustedTimezone();
        const year = targetDate.getFullYear();
        const month = targetDate.getMonth() + 1;
        const lastDay = new Date(year, month, 0).getDate();
        const components = context.createParsingComponents();
        components.assign("day", lastDay);
        components.assign("month", month);
        components.assign("year", year);
        components.addTag("parser/ENEndOfCurrentMonthParser");
        return components;
    }
}
exports.default = ENEndOfCurrentMonthParser;
//# sourceMappingURL=ENEndOfCurrentMonthParser.js.map