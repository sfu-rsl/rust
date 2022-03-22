/* global addClass, getNakedUrl, getSettingValue, hasOwnPropertyRustdoc, initSearch, onEach */
/* global onEachLazy, removeClass, searchState, hasClass */

(function() {
// This mapping table should match the discriminants of
// `rustdoc::formats::item_type::ItemType` type in Rust.
var itemTypes = [
    "mod",
    "externcrate",
    "import",
    "struct",
    "enum",
    "fn",
    "type",
    "static",
    "trait",
    "impl",
    "tymethod",
    "method",
    "structfield",
    "variant",
    "macro",
    "primitive",
    "associatedtype",
    "constant",
    "associatedconstant",
    "union",
    "foreigntype",
    "keyword",
    "existential",
    "attr",
    "derive",
    "traitalias",
];

// used for special search precedence
var TY_PRIMITIVE = itemTypes.indexOf("primitive");
var TY_KEYWORD = itemTypes.indexOf("keyword");

// In the search display, allows to switch between tabs.
function printTab(nb) {
    if (nb === 0 || nb === 1 || nb === 2) {
        searchState.currentTab = nb;
    }
    var nb_copy = nb;
    onEachLazy(document.getElementById("titles").childNodes, function(elem) {
        if (nb_copy === 0) {
            addClass(elem, "selected");
        } else {
            removeClass(elem, "selected");
        }
        nb_copy -= 1;
    });
    onEachLazy(document.getElementById("results").childNodes, function(elem) {
        if (nb === 0) {
            addClass(elem, "active");
        } else {
            removeClass(elem, "active");
        }
        nb -= 1;
    });
}

/**
 * A function to compute the Levenshtein distance between two strings
 * Licensed under the Creative Commons Attribution-ShareAlike 3.0 Unported
 * Full License can be found at http://creativecommons.org/licenses/by-sa/3.0/legalcode
 * This code is an unmodified version of the code written by Marco de Wit
 * and was found at https://stackoverflow.com/a/18514751/745719
 */
var levenshtein_row2 = [];
function levenshtein(s1, s2) {
    if (s1 === s2) {
        return 0;
    }
    var s1_len = s1.length, s2_len = s2.length;
    if (s1_len && s2_len) {
        var i1 = 0, i2 = 0, a, b, c, c2, row = levenshtein_row2;
        while (i1 < s1_len) {
            row[i1] = ++i1;
        }
        while (i2 < s2_len) {
            c2 = s2.charCodeAt(i2);
            a = i2;
            ++i2;
            b = i2;
            for (i1 = 0; i1 < s1_len; ++i1) {
                c = a + (s1.charCodeAt(i1) !== c2 ? 1 : 0);
                a = row[i1];
                b = b < a ? (b < c ? b + 1 : c) : (a < c ? a + 1 : c);
                row[i1] = b;
            }
        }
        return b;
    }
    return s1_len + s2_len;
}

window.initSearch = function(rawSearchIndex) {
    var MAX_LEV_DISTANCE = 3;
    var MAX_RESULTS = 200;
    var GENERICS_DATA = 2;
    var NAME = 0;
    var INPUTS_DATA = 0;
    var OUTPUT_DATA = 1;
    var NO_TYPE_FILTER = -1;
    /**
     *  @type {Array<Row>}
     */
    var searchIndex;
    /**
     *  @type {Array<string>}
     */
    var searchWords;
    var currentResults;
    var ALIASES = {};
    var params = searchState.getQueryStringParams();

    // Populate search bar with query string search term when provided,
    // but only if the input bar is empty. This avoid the obnoxious issue
    // where you start trying to do a search, and the index loads, and
    // suddenly your search is gone!
    if (searchState.input.value === "") {
        searchState.input.value = params.search || "";
    }

    function isWhitespace(c) {
        return " \t\n\r".indexOf(c) !== -1;
    }

    function isSpecialStartCharacter(c) {
        return "<\"".indexOf(c) !== -1;
    }

    function isEndCharacter(c) {
        return ",>-".indexOf(c) !== -1;
    }

    function isStopCharacter(c) {
        return isWhitespace(c) || isEndCharacter(c);
    }

    function isErrorCharacter(c) {
        return "()".indexOf(c) !== -1;
    }

    function itemTypeFromName(typename) {
        for (var i = 0, len = itemTypes.length; i < len; ++i) {
            if (itemTypes[i] === typename) {
                return i;
            }
        }

        throw new Error("Unknown type filter `" + typename + "`");
    }

    /**
     * If we encounter a `"`, then we try to extract the string from it until we find another `"`.
     *
     * This function will throw an error in the following cases:
     * * There is already another string element.
     * * We are parsing a generic argument.
     * * There is more than one element.
     * * There is no closing `"`.
     *
     * @param {ParsedQuery} query
     * @param {ParserState} parserState
     * @param {boolean} isInGenerics
     */
    function getStringElem(query, parserState, isInGenerics) {
        if (isInGenerics) {
            throw new Error("`\"` cannot be used in generics");
        } else if (query.literalSearch) {
            throw new Error("Cannot have more than one literal search element");
        } else if (parserState.totalElems !== 0) {
            throw new Error("Cannot use literal search when there is more than one element");
        }
        parserState.pos += 1;
        while (parserState.pos < parserState.length &&
            parserState.userQuery[parserState.pos] !== "\"")
        {
            parserState.pos += 1;
        }
        if (parserState.pos >= parserState.length) {
            throw new Error("Unclosed `\"`");
        }
        // To skip the quote at the end.
        parserState.pos += 1;
        query.literalSearch = true;
    }

    /**
     * Returns `true` if the current parser position is starting with "::".
     *
     * @param {ParserState} parserState
     *
     * @return {boolean}
     */
    function isPathStart(parserState) {
        return parserState.userQuery.slice(parserState.pos, parserState.pos + 2) == '::';
    }

    /**
     * Returns `true` if the current parser position is starting with "->".
     *
     * @param {ParserState} parserState
     *
     * @return {boolean}
     */
    function isReturnArrow(parserState) {
        return parserState.userQuery.slice(parserState.pos, parserState.pos + 2) == '->';
    }

    /**
     * @param {ParsedQuery} query
     * @param {ParserState} parserState
     * @param {string} name                  - Name of the query element.
     * @param {Array<QueryElement>} generics - List of generics of this query element.
     *
     * @return {QueryElement}                - The newly created `QueryElement`.
     */
    function createQueryElement(query, parserState, name, generics) {
        if (name === '*' || (name.length === 0 && generics.length === 0)) {
            return;
        }
        if (query.literalSearch && parserState.totalElems > 0) {
            throw new Error("You cannot have more than one element if you use quotes");
        }
        var pathSegments = name.split("::");
        if (pathSegments.length > 1) {
            for (var i = 0, len = pathSegments.length; i < len; ++i) {
                var pathSegment = pathSegments[i];

                if (pathSegment.length === 0) {
                    if (i === 0) {
                        throw new Error("Paths cannot start with `::`");
                    } else if (i + 1 === len) {
                        throw new Error("Paths cannot end with `::`");
                    }
                    throw new Error("Unexpected `::::`");
                }
            }
        }
        // In case we only have something like `<p>`, there is no name.
        if (pathSegments.length === 0 || (pathSegments.length === 1 && pathSegments[0] === "")) {
            throw new Error("Found generics without a path");
        }
        parserState.totalElems += 1;
        return {
            name: name,
            fullPath: pathSegments,
            pathWithoutLast: pathSegments.slice(0, pathSegments.length - 1),
            pathLast: pathSegments[pathSegments.length - 1],
            generics: generics,
        };
    }

    /**
     * @param {ParsedQuery} query
     * @param {ParserState} parserState
     * @param {Array<QueryElement>} elems - This is where the new {QueryElement} will be added.
     * @param {boolean} isInGenerics
     */
    function getNextElem(query, parserState, elems, isInGenerics) {
        var generics = [];

        var start = parserState.pos;
        var end = start;
        // We handle the strings on their own mostly to make code easier to follow.
        if (parserState.userQuery[parserState.pos] === "\"") {
            start += 1;
            getStringElem(query, parserState, isInGenerics);
            end = parserState.pos - 1;
        } else {
            while (parserState.pos < parserState.length) {
                var c = parserState.userQuery[parserState.pos];
                if (isErrorCharacter(c)) {
                    throw new Error(`Unexpected \`${c}\``);
                } else if (isStopCharacter(c) || isSpecialStartCharacter(c)) {
                    break;
                }
                // If we allow paths ("str::string" for example).
                else if (c === ":") {
                    if (!isPathStart(parserState)) {
                        break;
                    }
                    // Skip current ":".
                    parserState.pos += 1;
                }
                parserState.pos += 1;
                end = parserState.pos;
            }
        }
        if (parserState.pos < parserState.length &&
            parserState.userQuery[parserState.pos] === "<")
        {
            if (isInGenerics) {
                throw new Error("Unexpected `<` after `<`");
            }
            parserState.pos += 1;
            getItemsBefore(query, parserState, generics, ">");
        }
        if (start >= end && generics.length === 0) {
            return;
        }
        elems.push(
            createQueryElement(
                query,
                parserState,
                parserState.userQuery.slice(start, end),
                generics
            )
        );
    }

    /**
     * This function parses the next query element until it finds `endChar`, calling `getNextElem`
     * to collect each element.
     *
     * If there is no `endChar`, this function will implicitly stop at the end without raising an
     * error.
     *
     * @param {ParsedQuery} query
     * @param {ParserState} parserState
     * @param {Array<QueryElement>} elems - This is where the new {QueryElement} will be added.
     * @param {string} endChar            - This function will stop when it'll encounter this
     *                                      character.
     */
    function getItemsBefore(query, parserState, elems, endChar) {
        var turns = 0;
        while (parserState.pos < parserState.length) {
            var c = parserState.userQuery[parserState.pos];
            if (c === endChar) {
                break;
            } else if (c === "," && endChar !== "" && turns > 0) {
                parserState.pos += 1;
                continue;
            } else if (c === ":" && isPathStart(parserState)) {
                throw new Error("Unexpected `::`: paths cannot start with `::`");
            } else if (c === ":" || isEndCharacter(c)) {
                var extra = "";
                if (endChar === ">") {
                    extra = "`<`";
                } else if (endChar === "") {
                    extra = "`->`";
                }
                throw new Error("Unexpected `" + c + "` after " + extra);
            }
            var posBefore = parserState.pos;
            getNextElem(query, parserState, elems, endChar === ">");
            turns += 1;
            // This case can be encountered if `getNextElem` encounted a "stop character" right from
            // the start. For example if you have `,,`. In this case, we simply move up the current
            // position to continue the parsing.
            if (posBefore === parserState.pos) {
                parserState.pos += 1;
            }
        }
        // We are either at the end of the string or on the `endChar`` character, let's move forward
        // in any case.
        parserState.pos += 1;
    }

    /**
     * Parses the provided `query` input to fill `parserState`. If it encounters an error while
     * parsing `query`, it'll throw an error.
     *
     * @param {ParsedQuery} query
     * @param {ParserState} parserState
     */
    function parseInput(query, parserState) {
        var c, before;

        while (parserState.pos < parserState.length) {
            c = parserState.userQuery[parserState.pos];
            if (isStopCharacter(c)) {
                if (c === "," || c === " ") {
                    parserState.pos += 1;
                    continue;
                } else if (c === "-" || c === ">") {
                    if (isReturnArrow(parserState)) {
                        break;
                    }
                    throw new Error(`Unexpected \`${c}\` (did you mean \`->\`?)`);
                }
            } else if (c === ":" &&
                parserState.typeFilter === null &&
                !isPathStart(parserState))
            {
                if (query.elems.length === 0) {
                    throw new Error("Expected type filter before `:`");
                } else if (query.elems.length !== 1 || parserState.totalElems !== 1) {
                    throw new Error("Unexpected `:`");
                }
                if (query.literalSearch) {
                    throw new Error("You cannot use quotes on type filter");
                }
                // The type filter doesn't count as an element since it's a modifier.
                parserState.typeFilter = query.elems.pop().name;
                parserState.pos += 1;
                parserState.totalElems = 0;
                query.literalSearch = false;
                continue;
            }
            before = query.elems.length;
            getNextElem(query, parserState, query.elems, false);
            if (query.elems.length === before) {
                // Nothing was added, let's check it's not because of a solo ":"!
                if (parserState.pos >= parserState.length ||
                    parserState.userQuery[parserState.pos] !== ":")
                {
                    break;
                }
                parserState.pos += 1;
            }
        }
        while (parserState.pos < parserState.length) {
            c = parserState.userQuery[parserState.pos];
            if (isReturnArrow(parserState)) {
                parserState.pos += 2;
                // Get returned elements.
                getItemsBefore(query, parserState, query.returned, "");
                // Nothing can come afterward!
                break;
            } else {
                parserState.pos += 1;
            }
        }
    }

    /**
     * Takes the user search input and returns an empty `ParsedQuery`.
     *
     * @param {string} userQuery
     *
     * @return {ParsedQuery}
     */
    function newParsedQuery(userQuery) {
        return {
            original: userQuery,
            userQuery: userQuery.toLowerCase(),
            typeFilter: NO_TYPE_FILTER,
            elems: [],
            returned: [],
            // Total number of "top" elements (does not include generics).
            foundElems: 0,
            literalSearch: false,
            error: null,
        };
    }

    /**
     * Build an URL with search parameters.
     *
     * @param {string} search            - The current search being performed.
     * @param {string|null} filterCrates - The current filtering crate (if any).
     *
     * @return {string}
     */
    function buildUrl(search, filterCrates) {
        var extra = "?search=" + encodeURIComponent(search);

        if (filterCrates !== null) {
            extra += "&filter-crate=" + encodeURIComponent(filterCrates);
        }
        return getNakedUrl() + extra + window.location.hash;
    }

    /**
     * Return the filtering crate or `null` if there is none.
     *
     * @return {string|null}
     */
    function getFilterCrates() {
        var elem = document.getElementById("crate-search");

        if (elem &&
            elem.value !== "All crates" &&
            hasOwnPropertyRustdoc(rawSearchIndex, elem.value))
        {
            return elem.value;
        }
        return null;
    }

    /**
     * Parses the query.
     *
     * The supported syntax by this parser is as follow:
     *
     * ident = *(ALPHA / DIGIT / "_")
     * path = ident *(DOUBLE-COLON ident)
     * arg = path [generics]
     * arg-without-generic = path
     * type-sep = COMMA/WS *(COMMA/WS)
     * nonempty-arg-list = arg *(type-sep arg) *(COMMA/WS)
     * nonempty-arg-list-without-generics = arg-without-generic *(type-sep arg-without-generic)
     *                                      *(COMMA/WS)
     * generics = OPEN-ANGLE-BRACKET *WS [ nonempty-arg-list-without-generics ] *WS
     *            CLOSE-ANGLE-BRACKET
     * return-args = RETURN-ARROW *WS nonempty-arg-list
     *
     * exact-search = [type-filter *WS COLON] *WS QUOTE ident QUOTE *WS [generics]
     * type-search = [type-filter *WS COLON] *WS path *WS nonempty-arg-list
     *
     * query = *WS (exact-search / type-search / return-args) *WS
     *
     * type-filter = (
     *     "mod" /
     *     "externcrate" /
     *     "import" /
     *     "struct" /
     *     "enum" /
     *     "fn" /
     *     "type" /
     *     "static" /
     *     "trait" /
     *     "impl" /
     *     "tymethod" /
     *     "method" /
     *     "structfield" /
     *     "variant" /
     *     "macro" /
     *     "primitive" /
     *     "associatedtype" /
     *     "constant" /
     *     "associatedconstant" /
     *     "union" /
     *     "foreigntype" /
     *     "keyword" /
     *     "existential" /
     *     "attr" /
     *     "derive" /
     *     "traitalias")
     *
     * OPEN-ANGLE-BRACKET = "<"
     * CLOSE-ANGLE-BRACKET = ">"
     * COLON = ":"
     * DOUBLE-COLON = "::"
     * QUOTE = %x22
     * COMMA = ","
     * RETURN-ARROW = "->"
     *
     * ALPHA = %x41-5A / %x61-7A ; A-Z / a-z
     * DIGIT = %x30-39
     * WS = %x09 / " "
     *
     * @param  {string} val     - The user query
     *
     * @return {ParsedQuery}    - The parsed query
     */
    function parseQuery(userQuery) {
        userQuery = userQuery.trim();
        var parserState = {
            length: userQuery.length,
            pos: 0,
            // Total number of elements (includes generics).
            totalElems: 0,
            typeFilter: null,
            userQuery: userQuery.toLowerCase(),
        };
        var query = newParsedQuery(userQuery);

        try {
            parseInput(query, parserState);
            if (parserState.typeFilter !== null) {
                var typeFilter = parserState.typeFilter;
                if (typeFilter === "const") {
                    typeFilter = "constant";
                }
                query.typeFilter = itemTypeFromName(typeFilter);
            }
        } catch (err) {
            query = newParsedQuery(userQuery);
            query.error = err.message;
            return query;
        }

        if (!query.literalSearch) {
            // If there is more than one element in the query, we switch to literalSearch in any
            // case.
            query.literalSearch = parserState.totalElems > 1;
        }
        query.foundElems = query.elems.length + query.returned.length;
        if (query.foundElems === 0 && parserState.length !== 0) {
            // In this case, we'll simply keep whatever was entered by the user...
            query.elems.push(createQueryElement(query, parserState, userQuery, []));
            query.foundElems += 1;
        }
        return query;
    }

    /**
     * Creates the query results.
     *
     * @param {Array<Result>} results_in_args
     * @param {Array<Result>} results_returned
     * @param {Array<Result>} results_in_args
     * @param {ParsedQuery} parsedQuery
     *
     * @return {ResultsTable}
     */
    function createQueryResults(results_in_args, results_returned, results_others, parsedQuery) {
        return {
            "in_args": results_in_args,
            "returned": results_returned,
            "others": results_others,
            "query": parsedQuery,
        };
    }

    /**
     * Executes the parsed query and builds a {ResultsTable}.
     *
     * @param  {ParsedQuery} parsedQuery - The parsed user query
     * @param  {Object} searchWords      - The list of search words to query against
     * @param  {Object} [filterCrates]   - Crate to search in if defined
     *
     * @return {ResultsTable}
     */
    function execQuery(parsedQuery, searchWords, filterCrates) {
        var results_others = {}, results_in_args = {}, results_returned = {};

        function transformResults(results) {
            var duplicates = {};
            var out = [];

            for (var i = 0, len = results.length; i < len; ++i) {
                var result = results[i];

                if (result.id > -1) {
                    var obj = searchIndex[result.id];
                    obj.lev = result.lev;
                    var res = buildHrefAndPath(obj);
                    obj.displayPath = pathSplitter(res[0]);
                    obj.fullPath = obj.displayPath + obj.name;
                    // To be sure than it some items aren't considered as duplicate.
                    obj.fullPath += "|" + obj.ty;

                    if (duplicates[obj.fullPath]) {
                        continue;
                    }
                    duplicates[obj.fullPath] = true;

                    obj.href = res[1];
                    out.push(obj);
                    if (out.length >= MAX_RESULTS) {
                        break;
                    }
                }
            }
            return out;
        }

        function sortResults(results, isType) {
            var userQuery = parsedQuery.userQuery;
            var ar = [];
            for (var entry in results) {
                if (hasOwnPropertyRustdoc(results, entry)) {
                    var result = results[entry];
                    result.word = searchWords[result.id];
                    result.item = searchIndex[result.id] || {};
                    ar.push(result);
                }
            }
            results = ar;
            // if there are no results then return to default and fail
            if (results.length === 0) {
                return [];
            }

            results.sort(function(aaa, bbb) {
                var a, b;

                // sort by exact match with regard to the last word (mismatch goes later)
                a = (aaa.word !== userQuery);
                b = (bbb.word !== userQuery);
                if (a !== b) { return a - b; }

                // Sort by non levenshtein results and then levenshtein results by the distance
                // (less changes required to match means higher rankings)
                a = (aaa.lev);
                b = (bbb.lev);
                if (a !== b) { return a - b; }

                // sort by crate (non-current crate goes later)
                a = (aaa.item.crate !== window.currentCrate);
                b = (bbb.item.crate !== window.currentCrate);
                if (a !== b) { return a - b; }

                // sort by item name length (longer goes later)
                a = aaa.word.length;
                b = bbb.word.length;
                if (a !== b) { return a - b; }

                // sort by item name (lexicographically larger goes later)
                a = aaa.word;
                b = bbb.word;
                if (a !== b) { return (a > b ? +1 : -1); }

                // sort by index of keyword in item name (no literal occurrence goes later)
                a = (aaa.index < 0);
                b = (bbb.index < 0);
                if (a !== b) { return a - b; }
                // (later literal occurrence, if any, goes later)
                a = aaa.index;
                b = bbb.index;
                if (a !== b) { return a - b; }

                // special precedence for primitive and keyword pages
                if ((aaa.item.ty === TY_PRIMITIVE && bbb.item.ty !== TY_KEYWORD) ||
                    (aaa.item.ty === TY_KEYWORD && bbb.item.ty !== TY_PRIMITIVE)) {
                    return -1;
                }
                if ((bbb.item.ty === TY_PRIMITIVE && aaa.item.ty !== TY_PRIMITIVE) ||
                    (bbb.item.ty === TY_KEYWORD && aaa.item.ty !== TY_KEYWORD)) {
                    return 1;
                }

                // sort by description (no description goes later)
                a = (aaa.item.desc === "");
                b = (bbb.item.desc === "");
                if (a !== b) { return a - b; }

                // sort by type (later occurrence in `itemTypes` goes later)
                a = aaa.item.ty;
                b = bbb.item.ty;
                if (a !== b) { return a - b; }

                // sort by path (lexicographically larger goes later)
                a = aaa.item.path;
                b = bbb.item.path;
                if (a !== b) { return (a > b ? +1 : -1); }

                // que sera, sera
                return 0;
            });

            var nameSplit = null;
            if (parsedQuery.elems.length === 1) {
                var hasPath = typeof parsedQuery.elems[0].path === "undefined";
                nameSplit = hasPath ? null : parsedQuery.elems[0].path;
            }

            for (var i = 0, len = results.length; i < len; ++i) {
                result = results[i];

                // this validation does not make sense when searching by types
                if (result.dontValidate) {
                    continue;
                }
                var name = result.item.name.toLowerCase(),
                    path = result.item.path.toLowerCase(),
                    parent = result.item.parent;

                if (!isType && !validateResult(name, path, nameSplit, parent)) {
                    result.id = -1;
                }
            }
            return transformResults(results);
        }

        /**
         * This function checks if the object (`row`) generics match the given type (`elem`)
         * generics. If there are no generics on `row`, `defaultLev` is returned.
         *
         * @param {Row} row            - The object to check.
         * @param {QueryElement} elem  - The element from the parsed query.
         * @param {integer} defaultLev - This is the value to return in case there are no generics.
         *
         * @return {integer}           - Returns the best match (if any) or `MAX_LEV_DISTANCE + 1`.
         */
        function checkGenerics(row, elem, defaultLev) {
            if (row.length <= GENERICS_DATA || row[GENERICS_DATA].length === 0) {
                return elem.generics.length === 0 ? defaultLev : MAX_LEV_DISTANCE + 1;
            } else if (row[GENERICS_DATA].length > 0 && row[GENERICS_DATA][0][NAME] === "") {
                if (row.length > GENERICS_DATA) {
                    return checkGenerics(row[GENERICS_DATA][0], elem, defaultLev);
                }
                return elem.generics.length === 0 ? defaultLev : MAX_LEV_DISTANCE + 1;
            }
            // The names match, but we need to be sure that all generics kinda
            // match as well.
            var elem_name;
            if (elem.generics.length > 0 && row[GENERICS_DATA].length >= elem.generics.length) {
                var elems = Object.create(null);
                for (var x = 0, length = row[GENERICS_DATA].length; x < length; ++x) {
                    elem_name = row[GENERICS_DATA][x][NAME];
                    if (elem_name === "") {
                        // Pure generic, needs to check into it.
                        if (checkGenerics(
                                row[GENERICS_DATA][x], elem, MAX_LEV_DISTANCE + 1) !== 0) {
                            return MAX_LEV_DISTANCE + 1;
                        }
                        continue;
                    }
                    if (elems[elem_name] === undefined) {
                        elems[elem_name] = 0;
                    }
                    elems[elem_name] += 1;
                }
                // We need to find the type that matches the most to remove it in order
                // to move forward.
                for (x = 0, length = elem.generics.length; x < length; ++x) {
                    var generic = elem.generics[x];
                    var match = null;
                    if (elems[generic.name]) {
                        match = generic.name;
                    } else {
                        for (elem_name in elems) {
                            if (!hasOwnPropertyRustdoc(elems, elem_name)) {
                                continue;
                            }
                            if (elem_name === generic) {
                                match = elem_name;
                                break;
                            }
                        }
                    }
                    if (match === null) {
                        return MAX_LEV_DISTANCE + 1;
                    }
                    elems[match] -= 1;
                    if (elems[match] === 0) {
                        delete elems[match];
                    }
                }
                return 0;
            }
            return MAX_LEV_DISTANCE + 1;
        }

        /**
          * This function checks if the object (`row`) matches the given type (`elem`) and its
          * generics (if any).
          *
          * @param {Row} row
          * @param {QueryElement} elem    - The element from the parsed query.
          *
          * @return {integer} - Returns a Levenshtein distance to the best match.
          */
        function checkIfInGenerics(row, elem) {
            var lev = MAX_LEV_DISTANCE + 1;
            for (var x = 0, length = row[GENERICS_DATA].length; x < length && lev !== 0; ++x) {
                lev = Math.min(
                    checkType(row[GENERICS_DATA][x], elem, true),
                    lev
                );
            }
            return lev;
        }

        /**
          * This function checks if the object (`row`) matches the given type (`elem`) and its
          * generics (if any).
          *
          * @param {Row} row
          * @param {QueryElement} elem      - The element from the parsed query.
          * @param {boolean} literalSearch
          *
          * @return {integer} - Returns a Levenshtein distance to the best match. If there is
          *                     no match, returns `MAX_LEV_DISTANCE + 1`.
          */
        function checkType(row, elem, literalSearch) {
            if (elem.name.length === 0 || row[NAME].length === 0) {
                // This is a pure "generic" search, no need to run other checks.
                if (row.length > GENERICS_DATA) {
                    return checkIfInGenerics(row, elem);
                }
                return MAX_LEV_DISTANCE + 1;
            }

            var lev = levenshtein(row[NAME], elem.name);
            if (literalSearch) {
                if (lev !== 0) {
                    // The name didn't match, let's try to check if the generics do.
                    if (elem.generics.length === 0) {
                        var checkGeneric = (row.length > GENERICS_DATA &&
                            row[GENERICS_DATA].length > 0);
                        if (checkGeneric && row[GENERICS_DATA].findIndex(function(tmp_elem) {
                            return tmp_elem[NAME] === elem.name;
                        }) !== -1) {
                            return 0;
                        }
                    }
                    return MAX_LEV_DISTANCE + 1;
                } else if (elem.generics.length > 0) {
                    return checkGenerics(row, elem, MAX_LEV_DISTANCE + 1);
                }
                return 0;
            } else if (row.length > GENERICS_DATA) {
                if (elem.generics.length === 0) {
                    if (lev === 0) {
                        return 0;
                    }
                    // The name didn't match so we now check if the type we're looking for is inside
                    // the generics!
                    lev = checkIfInGenerics(row, elem);
                    // Now whatever happens, the returned distance is "less good" so we should mark
                    // it as such, and so we add 0.5 to the distance to make it "less good".
                    return lev + 0.5;
                } else if (lev > MAX_LEV_DISTANCE) {
                    // So our item's name doesn't match at all and has generics.
                    //
                    // Maybe it's present in a sub generic? For example "f<A<B<C>>>()", if we're
                    // looking for "B<C>", we'll need to go down.
                    return checkIfInGenerics(row, elem);
                } else {
                    // At this point, the name kinda match and we have generics to check, so
                    // let's go!
                    var tmp_lev = checkGenerics(row, elem, lev);
                    if (tmp_lev > MAX_LEV_DISTANCE) {
                        return MAX_LEV_DISTANCE + 1;
                    }
                    // We compute the median value of both checks and return it.
                    return (tmp_lev + lev) / 2;
                }
            } else if (elem.generics.length > 0) {
                // In this case, we were expecting generics but there isn't so we simply reject this
                // one.
                return MAX_LEV_DISTANCE + 1;
            }
            // No generics on our query or on the target type so we can return without doing
            // anything else.
            return lev;
        }

        /**
         * This function checks if the object (`row`) has an argument with the given type (`elem`).
         *
         * @param {Row} row
         * @param {QueryElement} elem    - The element from the parsed query.
         * @param {integer} typeFilter
         *
         * @return {integer} - Returns a Levenshtein distance to the best match. If there is no
         *                      match, returns `MAX_LEV_DISTANCE + 1`.
         */
        function findArg(row, elem, typeFilter) {
            var lev = MAX_LEV_DISTANCE + 1;

            if (row && row.type && row.type[INPUTS_DATA] && row.type[INPUTS_DATA].length > 0) {
                var length = row.type[INPUTS_DATA].length;
                for (var i = 0; i < length; i++) {
                    var tmp = row.type[INPUTS_DATA][i];
                    if (!typePassesFilter(typeFilter, tmp[1])) {
                        continue;
                    }
                    lev = Math.min(lev, checkType(tmp, elem, parsedQuery.literalSearch));
                    if (lev === 0) {
                        return 0;
                    }
                }
            }
            return parsedQuery.literalSearch ? MAX_LEV_DISTANCE + 1 : lev;
        }

        /**
         * This function checks if the object (`row`) returns the given type (`elem`).
         *
         * @param {Row} row
         * @param {QueryElement} elem   - The element from the parsed query.
         * @param {integer} typeFilter
         *
         * @return {integer} - Returns a Levenshtein distance to the best match. If there is no
         *                      match, returns `MAX_LEV_DISTANCE + 1`.
         */
        function checkReturned(row, elem, typeFilter) {
            var lev = MAX_LEV_DISTANCE + 1;

            if (row && row.type && row.type.length > OUTPUT_DATA) {
                var ret = row.type[OUTPUT_DATA];
                if (typeof ret[0] === "string") {
                    ret = [ret];
                }
                for (var x = 0, len = ret.length; x < len; ++x) {
                    var tmp = ret[x];
                    if (!typePassesFilter(typeFilter, tmp[1])) {
                        continue;
                    }
                    lev = Math.min(lev, checkType(tmp, elem, parsedQuery.literalSearch));
                    if (lev === 0) {
                        return 0;
                    }
                }
            }
            return parsedQuery.literalSearch ? MAX_LEV_DISTANCE + 1 : lev;
        }

        function checkPath(contains, lastElem, ty) {
            if (contains.length === 0) {
                return 0;
            }
            var ret_lev = MAX_LEV_DISTANCE + 1;
            var path = ty.path.split("::");

            if (ty.parent && ty.parent.name) {
                path.push(ty.parent.name.toLowerCase());
            }

            var length = path.length;
            var clength = contains.length;
            if (clength > length) {
                return MAX_LEV_DISTANCE + 1;
            }
            for (var i = 0; i < length; ++i) {
                if (i + clength > length) {
                    break;
                }
                var lev_total = 0;
                var aborted = false;
                for (var x = 0; x < clength; ++x) {
                    var lev = levenshtein(path[i + x], contains[x]);
                    if (lev > MAX_LEV_DISTANCE) {
                        aborted = true;
                        break;
                    }
                    lev_total += lev;
                }
                if (!aborted) {
                    ret_lev = Math.min(ret_lev, Math.round(lev_total / clength));
                }
            }
            return ret_lev;
        }

        function typePassesFilter(filter, type) {
            // No filter or Exact mach
            if (filter <= NO_TYPE_FILTER || filter === type) return true;

            // Match related items
            var name = itemTypes[type];
            switch (itemTypes[filter]) {
                case "constant":
                    return name === "associatedconstant";
                case "fn":
                    return name === "method" || name === "tymethod";
                case "type":
                    return name === "primitive" || name === "associatedtype";
                case "trait":
                    return name === "traitalias";
            }

            // No match
            return false;
        }

        function createAliasFromItem(item) {
            return {
                crate: item.crate,
                name: item.name,
                path: item.path,
                desc: item.desc,
                ty: item.ty,
                parent: item.parent,
                type: item.type,
                is_alias: true,
            };
        }

        function handleAliases(ret, query, filterCrates) {
            var lowerQuery = query.toLowerCase();
            // We separate aliases and crate aliases because we want to have current crate
            // aliases to be before the others in the displayed results.
            var aliases = [];
            var crateAliases = [];
            if (filterCrates !== null) {
                if (ALIASES[filterCrates] && ALIASES[filterCrates][lowerQuery]) {
                    var query_aliases = ALIASES[filterCrates][lowerQuery];
                    var len = query_aliases.length;
                    for (var i = 0; i < len; ++i) {
                        aliases.push(createAliasFromItem(searchIndex[query_aliases[i]]));
                    }
                }
            } else {
                Object.keys(ALIASES).forEach(function(crate) {
                    if (ALIASES[crate][lowerQuery]) {
                        var pushTo = crate === window.currentCrate ? crateAliases : aliases;
                        var query_aliases = ALIASES[crate][lowerQuery];
                        var len = query_aliases.length;
                        for (var i = 0; i < len; ++i) {
                            pushTo.push(createAliasFromItem(searchIndex[query_aliases[i]]));
                        }
                    }
                });
            }

            var sortFunc = function(aaa, bbb) {
                if (aaa.path < bbb.path) {
                    return 1;
                } else if (aaa.path === bbb.path) {
                    return 0;
                }
                return -1;
            };
            crateAliases.sort(sortFunc);
            aliases.sort(sortFunc);

            var pushFunc = function(alias) {
                alias.alias = query;
                var res = buildHrefAndPath(alias);
                alias.displayPath = pathSplitter(res[0]);
                alias.fullPath = alias.displayPath + alias.name;
                alias.href = res[1];

                ret.others.unshift(alias);
                if (ret.others.length > MAX_RESULTS) {
                    ret.others.pop();
                }
            };
            onEach(aliases, pushFunc);
            onEach(crateAliases, pushFunc);
        }

        /**
         * This function adds the given result into the provided `results` map if it matches the
         * following condition:
         *
         * * If it is a "literal search" (`parsedQuery.literalSearch`), then `lev` must be 0.
         * * If it is not a "literal search", `lev` must be <= `MAX_LEV_DISTANCE`.
         *
         * The `results` map contains information which will be used to sort the search results:
         *
         * * `fullId` is a `string`` used as the key of the object we use for the `results` map.
         * * `id` is the index in both `searchWords` and `searchIndex` arrays for this element.
         * * `index` is an `integer`` used to sort by the position of the word in the item's name.
         * * `lev` is the main metric used to sort the search results.
         *
         * @param {Results} results
         * @param {string} fullId
         * @param {integer} id
         * @param {integer} index
         * @param {integer} lev
         */
        function addIntoResults(results, fullId, id, index, lev) {
            if (lev === 0 || (!parsedQuery.literalSearch && lev <= MAX_LEV_DISTANCE)) {
                if (results[fullId] !== undefined) {
                    var result = results[fullId];
                    if (result.dontValidate || result.lev <= lev) {
                        return;
                    }
                }
                results[fullId] = {
                    id: id,
                    index: index,
                    dontValidate: parsedQuery.literalSearch,
                    lev: lev,
                };
            }
        }

        /**
         * This function is called in case the query is only one element (with or without generics).
         *
         * @param {Row} row
         * @param {integer} pos              - Position in the `searchIndex`.
         * @param {QueryElement} elem        - The element from the parsed query.
         * @param {Results} results_others   - Unqualified results (not in arguments nor in
         *                                     returned values).
         * @param {Results} results_in_args  - Matching arguments results.
         * @param {Results} results_returned - Matching returned arguments results.
         */
        function handleSingleArg(
            row,
            pos,
            elem,
            results_others,
            results_in_args,
            results_returned
        ) {
            if (!row || (filterCrates !== null && row.crate !== filterCrates)) {
                return;
            }
            var lev, lev_add = 0, index = -1;
            var fullId = row.id;

            var in_args = findArg(row, elem, parsedQuery.typeFilter);
            var returned = checkReturned(row, elem, parsedQuery.typeFilter);

            addIntoResults(results_in_args, fullId, pos, index, in_args);
            addIntoResults(results_returned, fullId, pos, index, returned);

            if (!typePassesFilter(parsedQuery.typeFilter, row.ty)) {
                return;
            }
            var searchWord = searchWords[pos];

            if (parsedQuery.literalSearch) {
                if (searchWord === elem.name) {
                    addIntoResults(results_others, fullId, pos, -1, 0);
                }
                return;
            }

            // No need to check anything else if it's a "pure" generics search.
            if (elem.name.length === 0) {
                if (row.type !== null) {
                    lev = checkGenerics(row.type, elem, MAX_LEV_DISTANCE + 1);
                    addIntoResults(results_others, fullId, pos, index, lev);
                }
                return;
            }

            if (elem.fullPath.length > 1) {
                lev = checkPath(elem.pathWithoutLast, elem.pathLast, row);
                if (lev > MAX_LEV_DISTANCE || (parsedQuery.literalSearch && lev !== 0)) {
                    return;
                } else if (lev > 0) {
                    lev_add = lev / 10;
                }
            }

            if (searchWord.indexOf(elem.pathLast) > -1 ||
                row.normalizedName.indexOf(elem.pathLast) > -1)
            {
                // filter type: ... queries
                if (!results_others[fullId] !== undefined) {
                    index = row.normalizedName.indexOf(elem.pathLast);
                }
            }
            lev = levenshtein(searchWord, elem.pathLast);
            lev += lev_add;
            if (lev > 0 && elem.pathLast.length > 2 && searchWord.indexOf(elem.pathLast) > -1)
            {
                if (elem.pathLast.length < 6) {
                    lev = 1;
                } else {
                    lev = 0;
                }
            }
            if (lev > MAX_LEV_DISTANCE) {
                return;
            } else if (index !== -1 && elem.fullPath.length < 2) {
                lev -= 1;
            }
            if (lev < 0) {
                lev = 0;
            }
            addIntoResults(results_others, fullId, pos, index, lev);
        }

        /**
         * This function is called in case the query has more than one element. In this case, it'll
         * try to match the items which validates all the elements. For `aa -> bb` will look for
         * functions which have a parameter `aa` and has `bb` in its returned values.
         *
         * @param {Row} row
         * @param {integer} pos      - Position in the `searchIndex`.
         * @param {Object} results
         */
        function handleArgs(row, pos, results) {
            if (!row || (filterCrates !== null && row.crate !== filterCrates)) {
                return;
            }

            var totalLev = 0;
            var nbLev = 0;
            var lev;

            // If the result is too "bad", we return false and it ends this search.
            function checkArgs(elems, callback) {
                for (var i = 0, len = elems.length; i < len; ++i) {
                    var elem = elems[i];
                    // There is more than one parameter to the query so all checks should be "exact"
                    lev = callback(row, elem, NO_TYPE_FILTER);
                    if (lev <= 1) {
                        nbLev += 1;
                        totalLev += lev;
                    } else {
                        return false;
                    }
                }
                return true;
            }
            if (!checkArgs(parsedQuery.elems, findArg)) {
                return;
            }
            if (!checkArgs(parsedQuery.returned, checkReturned)) {
                return;
            }

            if (nbLev === 0) {
                return;
            }
            lev = Math.round(totalLev / nbLev);
            addIntoResults(results, row.id, pos, 0, lev);
        }

        function innerRunQuery() {
            var elem, i, nSearchWords, in_returned, row;

            if (parsedQuery.foundElems === 1) {
                if (parsedQuery.elems.length === 1) {
                    elem = parsedQuery.elems[0];
                    for (i = 0, nSearchWords = searchWords.length; i < nSearchWords; ++i) {
                        // It means we want to check for this element everywhere (in names, args and
                        // returned).
                        handleSingleArg(
                            searchIndex[i],
                            i,
                            elem,
                            results_others,
                            results_in_args,
                            results_returned
                        );
                    }
                } else if (parsedQuery.returned.length === 1) {
                    // We received one returned argument to check, so looking into returned values.
                    elem = parsedQuery.returned[0];
                    for (i = 0, nSearchWords = searchWords.length; i < nSearchWords; ++i) {
                        row = searchIndex[i];
                        in_returned = checkReturned(row, elem, parsedQuery.typeFilter);
                        addIntoResults(results_returned, row.id, i, -1, in_returned);
                    }
                }
            } else if (parsedQuery.foundElems > 0) {
                var container = results_others;
                // In the special case where only a "returned" information is available, we want to
                // put the information into the "results_returned" dict.
                if (parsedQuery.returned.length !== 0 && parsedQuery.elems.length === 0) {
                    container = results_returned;
                }
                for (i = 0, nSearchWords = searchWords.length; i < nSearchWords; ++i) {
                    handleArgs(searchIndex[i], i, container);
                }
            }
        }

        if (parsedQuery.error === null) {
            innerRunQuery();
        }

        var ret = createQueryResults(
            sortResults(results_in_args, true),
            sortResults(results_returned, true),
            sortResults(results_others, false),
            parsedQuery);
        handleAliases(ret, parsedQuery.original.replace(/"/g, ""), filterCrates);
        if (parsedQuery.error !== null && ret.others.length !== 0) {
            // It means some doc aliases were found so let's "remove" the error!
            ret.query.error = null;
        }
        return ret;
    }

    /**
     * Validate performs the following boolean logic. For example:
     * "File::open" will give IF A PARENT EXISTS => ("file" && "open")
     * exists in (name || path || parent) OR => ("file" && "open") exists in
     * (name || path )
     *
     * This could be written functionally, but I wanted to minimise
     * functions on stack.
     *
     * @param  {string} name   - The name of the result
     * @param  {string} path   - The path of the result
     * @param  {string} keys   - The keys to be used (["file", "open"])
     * @param  {Object} parent - The parent of the result
     *
     * @return {boolean}       - Whether the result is valid or not
     */
    function validateResult(name, path, keys, parent) {
        if (!keys || !keys.length) {
            return true;
        }
        for (var i = 0, len = keys.length; i < len; ++i) {
            // each check is for validation so we negate the conditions and invalidate
            if (!(
                // check for an exact name match
                name.indexOf(keys[i]) > -1 ||
                // then an exact path match
                path.indexOf(keys[i]) > -1 ||
                // next if there is a parent, check for exact parent match
                (parent !== undefined && parent.name !== undefined &&
                    parent.name.toLowerCase().indexOf(keys[i]) > -1) ||
                // lastly check to see if the name was a levenshtein match
                levenshtein(name, keys[i]) <= MAX_LEV_DISTANCE)) {
                return false;
            }
        }
        return true;
    }

    function nextTab(direction) {
        var next = (searchState.currentTab + direction + 3) % searchState.focusedByTab.length;
        searchState.focusedByTab[searchState.currentTab] = document.activeElement;
        printTab(next);
        focusSearchResult();
    }

    // Focus the first search result on the active tab, or the result that
    // was focused last time this tab was active.
    function focusSearchResult() {
        var target = searchState.focusedByTab[searchState.currentTab] ||
            document.querySelectorAll(".search-results.active a").item(0) ||
            document.querySelectorAll("#titles > button").item(searchState.currentTab);
        if (target) {
            target.focus();
        }
    }

    function buildHrefAndPath(item) {
        var displayPath;
        var href;
        var type = itemTypes[item.ty];
        var name = item.name;
        var path = item.path;

        if (type === "mod") {
            displayPath = path + "::";
            href = window.rootPath + path.replace(/::/g, "/") + "/" +
                   name + "/index.html";
        } else if (type === "primitive" || type === "keyword") {
            displayPath = "";
            href = window.rootPath + path.replace(/::/g, "/") +
                   "/" + type + "." + name + ".html";
        } else if (type === "externcrate") {
            displayPath = "";
            href = window.rootPath + name + "/index.html";
        } else if (item.parent !== undefined) {
            var myparent = item.parent;
            var anchor = "#" + type + "." + name;
            var parentType = itemTypes[myparent.ty];
            var pageType = parentType;
            var pageName = myparent.name;

            if (parentType === "primitive") {
                displayPath = myparent.name + "::";
            } else if (type === "structfield" && parentType === "variant") {
                // Structfields belonging to variants are special: the
                // final path element is the enum name.
                var enumNameIdx = item.path.lastIndexOf("::");
                var enumName = item.path.substr(enumNameIdx + 2);
                path = item.path.substr(0, enumNameIdx);
                displayPath = path + "::" + enumName + "::" + myparent.name + "::";
                anchor = "#variant." + myparent.name + ".field." + name;
                pageType = "enum";
                pageName = enumName;
            } else {
                displayPath = path + "::" + myparent.name + "::";
            }
            href = window.rootPath + path.replace(/::/g, "/") +
                   "/" + pageType +
                   "." + pageName +
                   ".html" + anchor;
        } else {
            displayPath = item.path + "::";
            href = window.rootPath + item.path.replace(/::/g, "/") +
                   "/" + type + "." + name + ".html";
        }
        return [displayPath, href];
    }

    function escape(content) {
        var h1 = document.createElement("h1");
        h1.textContent = content;
        return h1.innerHTML;
    }

    function pathSplitter(path) {
        var tmp = "<span>" + path.replace(/::/g, "::</span><span>");
        if (tmp.endsWith("<span>")) {
            return tmp.slice(0, tmp.length - 6);
        }
        return tmp;
    }

    /**
     * Render a set of search results for a single tab.
     * @param {Array<?>}    array   - The search results for this tab
     * @param {ParsedQuery} query
     * @param {boolean}     display - True if this is the active tab
     */
    function addTab(array, query, display) {
        var extraClass = "";
        if (display === true) {
            extraClass = " active";
        }

        var output = document.createElement("div");
        var length = 0;
        if (array.length > 0) {
            output.className = "search-results " + extraClass;

            array.forEach(function(item) {
                var name = item.name;
                var type = itemTypes[item.ty];

                length += 1;

                var extra = "";
                if (type === "primitive") {
                    extra = " <i>(primitive type)</i>";
                } else if (type === "keyword") {
                    extra = " <i>(keyword)</i>";
                }

                var link = document.createElement("a");
                link.className = "result-" + type;
                link.href = item.href;

                var wrapper = document.createElement("div");
                var resultName = document.createElement("div");
                resultName.className = "result-name";

                if (item.is_alias) {
                    var alias = document.createElement("span");
                    alias.className = "alias";

                    var bold = document.createElement("b");
                    bold.innerText = item.alias;
                    alias.appendChild(bold);

                    alias.insertAdjacentHTML(
                        "beforeend",
                        "<span class=\"grey\"><i>&nbsp;- see&nbsp;</i></span>");

                    resultName.appendChild(alias);
                }
                resultName.insertAdjacentHTML(
                    "beforeend",
                    item.displayPath + "<span class=\"" + type + "\">" + name + extra + "</span>");
                wrapper.appendChild(resultName);

                var description = document.createElement("div");
                description.className = "desc";
                var spanDesc = document.createElement("span");
                spanDesc.insertAdjacentHTML("beforeend", item.desc);

                description.appendChild(spanDesc);
                wrapper.appendChild(description);
                link.appendChild(wrapper);
                output.appendChild(link);
            });
        } else if (query.error === null) {
            output.className = "search-failed" + extraClass;
            output.innerHTML = "No results :(<br/>" +
                "Try on <a href=\"https://duckduckgo.com/?q=" +
                encodeURIComponent("rust " + query.userQuery) +
                "\">DuckDuckGo</a>?<br/><br/>" +
                "Or try looking in one of these:<ul><li>The <a " +
                "href=\"https://doc.rust-lang.org/reference/index.html\">Rust Reference</a> " +
                " for technical details about the language.</li><li><a " +
                "href=\"https://doc.rust-lang.org/rust-by-example/index.html\">Rust By " +
                "Example</a> for expository code examples.</a></li><li>The <a " +
                "href=\"https://doc.rust-lang.org/book/index.html\">Rust Book</a> for " +
                "introductions to language features and the language itself.</li><li><a " +
                "href=\"https://docs.rs\">Docs.rs</a> for documentation of crates released on" +
                " <a href=\"https://crates.io/\">crates.io</a>.</li></ul>";
        }
        return [output, length];
    }

    function makeTabHeader(tabNb, text, nbElems) {
        if (searchState.currentTab === tabNb) {
            return "<button class=\"selected\">" + text +
                   " <div class=\"count\">(" + nbElems + ")</div></button>";
        }
        return "<button>" + text + " <div class=\"count\">(" + nbElems + ")</div></button>";
    }

    /**
     * @param {ResultsTable} results
     * @param {boolean} go_to_first
     * @param {string} filterCrates
     */
    function showResults(results, go_to_first, filterCrates) {
        var search = searchState.outputElement();
        if (go_to_first || (results.others.length === 1
            && getSettingValue("go-to-only-result") === "true"
            // By default, the search DOM element is "empty" (meaning it has no children not
            // text content). Once a search has been run, it won't be empty, even if you press
            // ESC or empty the search input (which also "cancels" the search).
            && (!search.firstChild || search.firstChild.innerText !== searchState.loadingText)))
        {
            var elem = document.createElement("a");
            elem.href = results.others[0].href;
            removeClass(elem, "active");
            // For firefox, we need the element to be in the DOM so it can be clicked.
            document.body.appendChild(elem);
            elem.click();
            return;
        }
        if (results.query === undefined) {
            results.query = parseQuery(searchState.input.value);
        }

        currentResults = results.query.userQuery;

        var ret_others = addTab(results.others, results.query, true);
        var ret_in_args = addTab(results.in_args, results.query, false);
        var ret_returned = addTab(results.returned, results.query, false);

        // Navigate to the relevant tab if the current tab is empty, like in case users search
        // for "-> String". If they had selected another tab previously, they have to click on
        // it again.
        var currentTab = searchState.currentTab;
        if ((currentTab === 0 && ret_others[1] === 0) ||
                (currentTab === 1 && ret_in_args[1] === 0) ||
                (currentTab === 2 && ret_returned[1] === 0)) {
            if (ret_others[1] !== 0) {
                currentTab = 0;
            } else if (ret_in_args[1] !== 0) {
                currentTab = 1;
            } else if (ret_returned[1] !== 0) {
                currentTab = 2;
            }
        }

        let crates = "";
        if (window.ALL_CRATES.length > 1) {
            crates = ` in <select id="crate-search"><option value="All crates">All crates</option>`;
            for (let c of window.ALL_CRATES) {
                crates += `<option value="${c}" ${c == filterCrates && "selected"}>${c}</option>`;
            }
            crates += `</select>`;
        }

        var typeFilter = "";
        if (results.query.typeFilter !== NO_TYPE_FILTER) {
            typeFilter = " (type: " + escape(itemTypes[results.query.typeFilter]) + ")";
        }

        var output = `<div id="search-settings">` +
            `<h1 class="search-results-title">Results for ${escape(results.query.userQuery)}` +
            `${typeFilter}</h1> in ${crates} </div>`;
        if (results.query.error !== null) {
            output += `<h3>Query parser error: "${results.query.error}".</h3>`;
        }
        output += `<div id="titles">` +
            makeTabHeader(0, "In Names", ret_others[1]) +
            makeTabHeader(1, "In Parameters", ret_in_args[1]) +
            makeTabHeader(2, "In Return Types", ret_returned[1]) +
            "</div>";

        var resultsElem = document.createElement("div");
        resultsElem.id = "results";
        resultsElem.appendChild(ret_others[0]);
        resultsElem.appendChild(ret_in_args[0]);
        resultsElem.appendChild(ret_returned[0]);

        search.innerHTML = output;
        let crateSearch = document.getElementById("crate-search");
        if (crateSearch) {
            crateSearch.addEventListener("input", updateCrate);
        }
        search.appendChild(resultsElem);
        // Reset focused elements.
        searchState.focusedByTab = [null, null, null];
        searchState.showResults(search);
        var elems = document.getElementById("titles").childNodes;
        elems[0].onclick = function() { printTab(0); };
        elems[1].onclick = function() { printTab(1); };
        elems[2].onclick = function() { printTab(2); };
        printTab(currentTab);
    }

    /**
     * Perform a search based on the current state of the search input element
     * and display the results.
     * @param {Event}   [e]       - The event that triggered this search, if any
     * @param {boolean} [forced]
     */
    function search(e, forced) {
        var params = searchState.getQueryStringParams();
        var query = parseQuery(searchState.input.value.trim());

        if (e) {
            e.preventDefault();
        }

        if (!forced && query.userQuery === currentResults) {
            if (query.userQuery.length > 0) {
                putBackSearch();
            }
            return;
        }

        var filterCrates = getFilterCrates();

        // In case we have no information about the saved crate and there is a URL query parameter,
        // we override it with the URL query parameter.
        if (filterCrates === null && params["filter-crate"] !== undefined) {
            filterCrates = params["filter-crate"];
        }

        // Update document title to maintain a meaningful browser history
        searchState.title = "Results for " + query.original + " - Rust";

        // Because searching is incremental by character, only the most
        // recent search query is added to the browser history.
        if (searchState.browserSupportsHistoryApi()) {
            var newURL = buildUrl(query.original, filterCrates);
            if (!history.state && !params.search) {
                history.pushState(null, "", newURL);
            } else {
                history.replaceState(null, "", newURL);
            }
        }

        showResults(
            execQuery(query, searchWords, filterCrates),
            params.go_to_first,
            filterCrates);
    }

    function buildIndex(rawSearchIndex) {
        searchIndex = [];
        /**
         * @type {Array<string>}
         */
        var searchWords = [];
        var i, word;
        var currentIndex = 0;
        var id = 0;

        for (var crate in rawSearchIndex) {
            if (!hasOwnPropertyRustdoc(rawSearchIndex, crate)) {
                continue;
            }

            var crateSize = 0;

            /**
             * The raw search data for a given crate. `n`, `t`, `d`, and `q`, `i`, and `f`
             * are arrays with the same length. n[i] contains the name of an item.
             * t[i] contains the type of that item (as a small integer that represents an
             * offset in `itemTypes`). d[i] contains the description of that item.
             *
             * q[i] contains the full path of the item, or an empty string indicating
             * "same as q[i-1]".
             *
             * i[i], f[i] are a mystery.
             *
             * `a` defines aliases with an Array of pairs: [name, offset], where `offset`
             * points into the n/t/d/q/i/f arrays.
             *
             * `doc` contains the description of the crate.
             *
             * `p` is a mystery and isn't the same length as n/t/d/q/i/f.
             *
             * @type {{
             *   doc: string,
             *   a: Object,
             *   n: Array<string>,
             *   t: Array<Number>,
             *   d: Array<string>,
             *   q: Array<string>,
             *   i: Array<Number>,
             *   f: Array<Array<?>>,
             *   p: Array<Object>,
             * }}
             */
            var crateCorpus = rawSearchIndex[crate];

            searchWords.push(crate);
            // This object should have exactly the same set of fields as the "row"
            // object defined below. Your JavaScript runtime will thank you.
            // https://mathiasbynens.be/notes/shapes-ics
            var crateRow = {
                crate: crate,
                ty: 1, // == ExternCrate
                name: crate,
                path: "",
                desc: crateCorpus.doc,
                parent: undefined,
                type: null,
                id: id,
                normalizedName: crate.indexOf("_") === -1 ? crate : crate.replace(/_/g, ""),
            };
            id += 1;
            searchIndex.push(crateRow);
            currentIndex += 1;

            // an array of (Number) item types
            var itemTypes = crateCorpus.t;
            // an array of (String) item names
            var itemNames = crateCorpus.n;
            // an array of (String) full paths (or empty string for previous path)
            var itemPaths = crateCorpus.q;
            // an array of (String) descriptions
            var itemDescs = crateCorpus.d;
            // an array of (Number) the parent path index + 1 to `paths`, or 0 if none
            var itemParentIdxs = crateCorpus.i;
            // an array of (Object | null) the type of the function, if any
            var itemFunctionSearchTypes = crateCorpus.f;
            // an array of [(Number) item type,
            //              (String) name]
            var paths = crateCorpus.p;
            // an array of [(String) alias name
            //             [Number] index to items]
            var aliases = crateCorpus.a;

            // convert `rawPaths` entries into object form
            var len = paths.length;
            for (i = 0; i < len; ++i) {
                paths[i] = {ty: paths[i][0], name: paths[i][1]};
            }

            // convert `item*` into an object form, and construct word indices.
            //
            // before any analysis is performed lets gather the search terms to
            // search against apart from the rest of the data.  This is a quick
            // operation that is cached for the life of the page state so that
            // all other search operations have access to this cached data for
            // faster analysis operations
            len = itemTypes.length;
            var lastPath = "";
            for (i = 0; i < len; ++i) {
                // This object should have exactly the same set of fields as the "crateRow"
                // object defined above.
                if (typeof itemNames[i] === "string") {
                    word = itemNames[i].toLowerCase();
                    searchWords.push(word);
                } else {
                    word = "";
                    searchWords.push("");
                }
                var row = {
                    crate: crate,
                    ty: itemTypes[i],
                    name: itemNames[i],
                    path: itemPaths[i] ? itemPaths[i] : lastPath,
                    desc: itemDescs[i],
                    parent: itemParentIdxs[i] > 0 ? paths[itemParentIdxs[i] - 1] : undefined,
                    type: itemFunctionSearchTypes[i],
                    id: id,
                    normalizedName: word.indexOf("_") === -1 ? word : word.replace(/_/g, ""),
                };
                id += 1;
                searchIndex.push(row);
                lastPath = row.path;
                crateSize += 1;
            }

            if (aliases) {
                ALIASES[crate] = {};
                var j, local_aliases;
                for (var alias_name in aliases) {
                    if (!hasOwnPropertyRustdoc(aliases, alias_name)) {
                        continue;
                    }

                    if (!hasOwnPropertyRustdoc(ALIASES[crate], alias_name)) {
                        ALIASES[crate][alias_name] = [];
                    }
                    local_aliases = aliases[alias_name];
                    for (j = 0, len = local_aliases.length; j < len; ++j) {
                        ALIASES[crate][alias_name].push(local_aliases[j] + currentIndex);
                    }
                }
            }
            currentIndex += crateSize;
        }
        return searchWords;
    }

    /**
     * Callback for when the search form is submitted.
     * @param {Event} [e] - The event that triggered this call, if any
     */
    function onSearchSubmit(e) {
        e.preventDefault();
        searchState.clearInputTimeout();
        search();
    }

    function putBackSearch() {
        var search_input = searchState.input;
        if (!searchState.input) {
            return;
        }
        var search = searchState.outputElement();
        if (search_input.value !== "" && hasClass(search, "hidden")) {
            searchState.showResults(search);
            if (searchState.browserSupportsHistoryApi()) {
                history.replaceState(null, "",
                    buildUrl(search_input.value, getFilterCrates()));
            }
            document.title = searchState.title;
        }
    }

    function registerSearchEvents() {
        var searchAfter500ms = function() {
            searchState.clearInputTimeout();
            if (searchState.input.value.length === 0) {
                if (searchState.browserSupportsHistoryApi()) {
                    history.replaceState(null, window.currentCrate + " - Rust",
                        getNakedUrl() + window.location.hash);
                }
                searchState.hideResults();
            } else {
                searchState.timeout = setTimeout(search, 500);
            }
        };
        searchState.input.onkeyup = searchAfter500ms;
        searchState.input.oninput = searchAfter500ms;
        document.getElementsByClassName("search-form")[0].onsubmit = onSearchSubmit;
        searchState.input.onchange = function(e) {
            if (e.target !== document.activeElement) {
                // To prevent doing anything when it's from a blur event.
                return;
            }
            // Do NOT e.preventDefault() here. It will prevent pasting.
            searchState.clearInputTimeout();
            // zero-timeout necessary here because at the time of event handler execution the
            // pasted content is not in the input field yet. Shouldn’t make any difference for
            // change, though.
            setTimeout(search, 0);
        };
        searchState.input.onpaste = searchState.input.onchange;

        searchState.outputElement().addEventListener("keydown", function(e) {
            // We only handle unmodified keystrokes here. We don't want to interfere with,
            // for instance, alt-left and alt-right for history navigation.
            if (e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) {
                return;
            }
            // up and down arrow select next/previous search result, or the
            // search box if we're already at the top.
            if (e.which === 38) { // up
                var previous = document.activeElement.previousElementSibling;
                if (previous) {
                    previous.focus();
                } else {
                    searchState.focus();
                }
                e.preventDefault();
            } else if (e.which === 40) { // down
                var next = document.activeElement.nextElementSibling;
                if (next) {
                    next.focus();
                }
                var rect = document.activeElement.getBoundingClientRect();
                if (window.innerHeight - rect.bottom < rect.height) {
                    window.scrollBy(0, rect.height);
                }
                e.preventDefault();
            } else if (e.which === 37) { // left
                nextTab(-1);
                e.preventDefault();
            } else if (e.which === 39) { // right
                nextTab(1);
                e.preventDefault();
            }
        });

        searchState.input.addEventListener("keydown", function(e) {
            if (e.which === 40) { // down
                focusSearchResult();
                e.preventDefault();
            }
        });

        searchState.input.addEventListener("focus", function() {
            putBackSearch();
        });

        searchState.input.addEventListener("blur", function() {
            searchState.input.placeholder = searchState.input.origPlaceholder;
        });

        // Push and pop states are used to add search results to the browser
        // history.
        if (searchState.browserSupportsHistoryApi()) {
            // Store the previous <title> so we can revert back to it later.
            var previousTitle = document.title;

            window.addEventListener("popstate", function(e) {
                var params = searchState.getQueryStringParams();
                // Revert to the previous title manually since the History
                // API ignores the title parameter.
                document.title = previousTitle;
                // When browsing forward to search results the previous
                // search will be repeated, so the currentResults are
                // cleared to ensure the search is successful.
                currentResults = null;
                // Synchronize search bar with query string state and
                // perform the search. This will empty the bar if there's
                // nothing there, which lets you really go back to a
                // previous state with nothing in the bar.
                if (params.search && params.search.length > 0) {
                    searchState.input.value = params.search;
                    // Some browsers fire "onpopstate" for every page load
                    // (Chrome), while others fire the event only when actually
                    // popping a state (Firefox), which is why search() is
                    // called both here and at the end of the startSearch()
                    // function.
                    search(e);
                } else {
                    searchState.input.value = "";
                    // When browsing back from search results the main page
                    // visibility must be reset.
                    searchState.hideResults();
                }
            });
        }

        // This is required in firefox to avoid this problem: Navigating to a search result
        // with the keyboard, hitting enter, and then hitting back would take you back to
        // the doc page, rather than the search that should overlay it.
        // This was an interaction between the back-forward cache and our handlers
        // that try to sync state between the URL and the search input. To work around it,
        // do a small amount of re-init on page show.
        window.onpageshow = function(){
            var qSearch = searchState.getQueryStringParams().search;
            if (searchState.input.value === "" && qSearch) {
                searchState.input.value = qSearch;
            }
            search();
        };
    }

    function updateCrate(ev) {
        if (ev.target.value === "All crates") {
            // If we don't remove it from the URL, it'll be picked up again by the search.
            var params = searchState.getQueryStringParams();
            var query = searchState.input.value.trim();
            if (!history.state && !params.search) {
                history.pushState(null, "", buildUrl(query, null));
            } else {
                history.replaceState(null, "", buildUrl(query, null));
            }
        }
        // In case you "cut" the entry from the search input, then change the crate filter
        // before paste back the previous search, you get the old search results without
        // the filter. To prevent this, we need to remove the previous results.
        currentResults = null;
        search(undefined, true);
    }

    searchWords = buildIndex(rawSearchIndex);
    registerSearchEvents();

    function runSearchIfNeeded() {
        // If there's a search term in the URL, execute the search now.
        if (searchState.getQueryStringParams().search) {
            search();
        }
    }

    runSearchIfNeeded();
};

if (window.searchIndex !== undefined) {
    initSearch(window.searchIndex);
}

})();
