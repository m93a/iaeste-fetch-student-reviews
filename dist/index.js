import { JSDOM } from "jsdom";
const domParser = new new JSDOM().window.DOMParser();
const parseDom = domParser.parseFromString.bind(domParser);
const mapOpt = (v, f) => v === undefined ? undefined : f(v);
const ROOT_URL = "https://www.iaeste.cz";
const BASE_URL = ROOT_URL + "/student-report?page=student_report_list";
const SUBLIST_URL = ROOT_URL + "/student-report?page=student_report_country";
const REVIEW_URL = ROOT_URL + "/student-report?page=student_report&id=";
const LANG_URL_FRAGMENT = "&lang=";
const UI_LANG_URL_FRAGMENT = "&ui_lang=";
const LANG_CZECH = "cs_cz";
const LANG_ENGLISH = "en_us";
const COUNTRY_URL_FRAGMENT = "&country=";
const COUNTRY_URL_FRAGMENT_REGEX = /&country=(\d+)/;
const FIELD_URL_FRAGMENT = "&faculty=";
const FIELD_URL_FRAGMENT_REGEX = /&faculty=(\d+)/;
const SPECIALIZATION_URL_FRAGMENT = "&specialization=";
const SPECIALIZATION_URL_FRAGMENT_REGEX = /&specialization=(\d+)/;
const REVIEW_ID_URL_FRAGMENT = "&id=";
const REVIEW_ID_URL_FRAGMENT_REGEX = /&id=(\d+)/;
const REVIEW_IN_CZECH_ICON = "i-cz.png";
async function urlToDocument(url) {
    const text = await (await fetch(url)).text();
    return parseDom(text, "text/html");
}
const isAnchor = (el) => el?.matches("a") ?? false;
const textOf = (el) => el?.textContent?.trim() ?? "";
async function getBaseTableCells(lang) {
    const doc = await urlToDocument(BASE_URL + LANG_URL_FRAGMENT + lang);
    const table = doc.querySelector(".content .tablediv table");
    return [...(table?.querySelectorAll("td") ?? [])];
}
export async function getBaseCategories() {
    const enCells = await getBaseTableCells(LANG_ENGLISH);
    const csCells = await getBaseTableCells(LANG_CZECH);
    const cats = [];
    for (const cell of enCells) {
        let cat;
        for (const el of cell.children) {
            if (el.matches("h2")) {
                cat = { en: textOf(el), countries: [] };
                cats.push(cat);
            }
            if (!cat || !isAnchor(el))
                continue;
            const id = Number(el.href.match(COUNTRY_URL_FRAGMENT_REGEX)?.[1] ?? -1);
            if (id !== -1)
                cat.countries.push({ en: textOf(el), id });
        }
    }
    // extract countries in czech
    const csHeadings = csCells.flatMap((c) => [...c.querySelectorAll("h2")]);
    for (const [i, heading] of csHeadings.entries())
        cats[i].cs = textOf(heading);
    const csAnchors = csCells.flatMap((c) => [...c.querySelectorAll("a")]);
    const countriesById = new Map(cats.flatMap(({ countries }) => countries).map((c) => [c.id, c]));
    csAnchors
        .map((a) => ({ cs: textOf(a), id: Number(a.href.match(COUNTRY_URL_FRAGMENT_REGEX)?.[1] ?? -1) }))
        .filter(({ id }) => id !== -1)
        .map(({ cs, id }) => ({ cs, country: countriesById.get(id) }))
        .forEach(({ country, cs }) => {
        if (country)
            country.cs = cs;
    });
    // collect all country categories
    const countryCategories = cats.map(({ en, cs, countries }) => ({
        name: { en, cs: cs ?? "" },
        countries: countries.map(({ id, en, cs }) => ({
            id,
            name: { en, cs: cs ?? "" },
        })),
    }));
    // extract fields
    const enAnchors = enCells.flatMap((c) => [...c.querySelectorAll("a")]);
    const enFields = new Map(enAnchors.map((a) => [Number(a.href.match(FIELD_URL_FRAGMENT_REGEX)?.[1] ?? -1), textOf(a)]));
    const csFields = new Map(csAnchors.map((a) => [Number(a.href.match(FIELD_URL_FRAGMENT_REGEX)?.[1] ?? -1), textOf(a)]));
    enFields.delete(-1);
    csFields.delete(-1);
    // collect all fields
    const fields = [...enFields.keys()].map((id) => ({
        id,
        name: { en: enFields.get(id) ?? "", cs: csFields.get(id) ?? "" },
    }));
    return {
        countryCategories,
        fields,
    };
}
export async function getSpecializationsOfField(fieldId) {
    const url = SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId;
    const enDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_ENGLISH);
    const csDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_CZECH);
    const [enItems, csItems] = [enDoc, csDoc].map((doc) => new Map([...doc.querySelectorAll(`a[href*="&faculty=${fieldId}"]`)]
        .map((a) => ({
        name: textOf(a),
        id: Number(a.href.match(SPECIALIZATION_URL_FRAGMENT_REGEX)?.[1] ?? -1),
    }))
        .filter(({ id }) => id !== -1)
        .map(({ id, name }) => [id, name])));
    const specs = [];
    for (const [id, en] of enItems) {
        const cs = csItems.get(id) ?? "";
        specs.push({ id, name: { en, cs } });
    }
    return specs;
}
export function getReviewEntriesByCountry(countryId) {
    return sublistToReviewEntries(SUBLIST_URL + COUNTRY_URL_FRAGMENT + countryId);
}
export function getReviewEntriesByField(fieldId) {
    return sublistToReviewEntries(SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId);
}
export function getReviewEntriesBySpecialization(fieldId, specializationId) {
    return sublistToReviewEntries(SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId + SPECIALIZATION_URL_FRAGMENT + specializationId);
}
async function sublistToReviewEntries(url) {
    const enDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_ENGLISH);
    const csDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_CZECH);
    const [enRows, csRows] = [enDoc, csDoc].map((doc) => [
        ...(doc.querySelector(".content .tablist table tbody")?.querySelectorAll("tr") ?? []),
    ]);
    csRows.shift();
    const headers = [...(enRows.shift()?.querySelectorAll("td, th") ?? [])].map((th) => textOf(th).toLowerCase());
    const findColumn = (str) => headers.findIndex((h) => h.includes(str)) + 1;
    const cols = {
        year: findColumn("year"),
        location: findColumn("location"),
        student: findColumn("student"),
        university: findColumn("university"),
        specialization: findColumn("specialization"),
    };
    const getColumn = (tr, i) => tr.querySelector(`td:nth-of-type(${i})`);
    return enRows.map((row, i) => {
        const a = getColumn(row, cols.location)?.querySelector("a");
        const id = Number(a?.href.match(REVIEW_ID_URL_FRAGMENT_REGEX)?.[1] ?? -1);
        const year = Number(textOf(getColumn(row, cols.year)));
        const location = textOf(getColumn(row, cols.location));
        const student = textOf(getColumn(row, cols.student))
            .split(",")
            .map((s) => s.trim());
        const [surname, name] = student;
        const reviewLanguage = row.querySelector(`img[src*="${REVIEW_IN_CZECH_ICON}"]`) === null ? "en" : "cs";
        const universityEn = textOf(getColumn(row, cols.university));
        const universityCs = mapOpt(csRows.find((row) => [...row.querySelectorAll("a")].some((a) => a.href.match(REVIEW_ID_URL_FRAGMENT + id))), (row) => textOf(getColumn(row, cols.university))) ?? "";
        const university = universityEn === "" && universityCs === ""
            ? undefined
            : {
                en: universityEn,
                cs: universityCs,
            };
        const thumbnailUrl = mapOpt(row.querySelector("img.thumb_img")?.src, (src) => ROOT_URL + src);
        return {
            id,
            year,
            location,
            student: { name, surname },
            reviewLanguage,
            university,
            thumbnailUrl,
        };
    });
}
