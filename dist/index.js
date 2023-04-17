import { PromisePool } from "@supercharge/promise-pool";
import { JSDOM } from "jsdom";
const domParser = new new JSDOM().window.DOMParser();
const parseDom = domParser.parseFromString.bind(domParser);
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_CONCURRENT_COUNTRIES = 4;
const ROOT_URL = "https://www.iaeste.cz";
const BASE_URL = ROOT_URL + "/student-report?page=student_report_list";
const SUBLIST_URL = ROOT_URL + "/student-report?page=student_report_country";
const REVIEW_URL = ROOT_URL + "/student-report?page=student_report&id=";
const LANG_URL_FRAGMENT = "&lang=";
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
const TOTAL_TIMER_LABEL = "Everything completed in";
async function urlToDocument(url, cache, retries = 5) {
    const cachedDoc = cache?.get(url);
    if (cachedDoc)
        return cachedDoc;
    const response = await fetch(url);
    if (!response.ok) {
        if (retries <= 0)
            throw Error(`Failed to fetch URL: ${url}`);
        // wait for 1s, 2s, 3.5s, 10s, 50s before trying again
        // maximum wait time before failing is ~1 min
        await delay(50_000 / retries ** 1.5);
        return urlToDocument(url, cache, retries - 1);
    }
    const text = await response.text();
    const doc = parseDom(text, "text/html");
    if (cache)
        cache.set(url, doc);
    return doc;
}
const isAnchor = (el) => el?.matches("a") ?? false;
const textOf = (el) => el?.textContent?.trim() ?? "";
const omit = (obj, ...keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const mapOpt = (v, f) => v === undefined ? undefined : f(v);
async function getBaseTableCells(lang, cache) {
    const doc = await urlToDocument(BASE_URL + LANG_URL_FRAGMENT + lang, cache);
    const table = doc.querySelector(".content .tablediv table");
    return [...(table?.querySelectorAll("td") ?? [])];
}
export async function getBaseCategories(cache) {
    const enCells = await getBaseTableCells(LANG_ENGLISH, cache);
    const csCells = await getBaseTableCells(LANG_CZECH, cache);
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
export async function getSpecializationsOfField(fieldId, cache) {
    const url = SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId;
    const enDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_ENGLISH, cache);
    const csDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_CZECH, cache);
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
        specs.push({ id, fieldId, name: { en, cs } });
    }
    return specs;
}
export function getReviewEntriesByCountry(countryId, cache) {
    return sublistToReviewEntries(SUBLIST_URL + COUNTRY_URL_FRAGMENT + countryId, cache);
}
export function getReviewEntriesByField(fieldId, cache) {
    return sublistToReviewEntries(SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId, cache);
}
export function getReviewEntriesBySpecialization(fieldId, specializationId, cache) {
    return sublistToReviewEntries(SUBLIST_URL + FIELD_URL_FRAGMENT + fieldId + SPECIALIZATION_URL_FRAGMENT + specializationId, cache);
}
async function sublistToReviewEntries(url, cache) {
    const enDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_ENGLISH, cache);
    const csDoc = await urlToDocument(url + LANG_URL_FRAGMENT + LANG_CZECH, cache);
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
export async function getReviewContent(id, cache) {
    const doc = await urlToDocument(REVIEW_URL + id, cache);
    const report = doc.querySelector(".student_report");
    // This here gets the year of study from the report title
    const yearOfStudy = textOf(report.querySelector("h4")).match(/year (.*)$/i)?.[1] ?? "";
    const photoLinks = [...(report.querySelector(".gallery")?.querySelectorAll("a") ?? [])];
    const photos = photoLinks.map((a) => ({
        fullSizeUrl: ROOT_URL + a.href,
        thumbnailUrl: mapOpt(a.querySelector("img")?.src, (s) => ROOT_URL + s) ?? "",
    }));
    const infoTable = report.querySelector("table.header");
    const infoRows = [...(infoTable?.querySelectorAll("tr") ?? [])];
    const infoCells = infoRows.map((row) => [...row.querySelectorAll("td")].map(textOf));
    const info = infoCells.map((innerArray) => innerArray[1]);
    // it seems all the actual text is in elements with the body class
    const reportBodies = report.querySelector("#report_body")?.querySelectorAll(".body");
    const bodiesTexts = [...(reportBodies ?? [])].map((body) => textOf(body));
    return {
        id,
        yearOfStudy,
        photos,
        fieldName: info[2],
        specializationName: info[3].trim(),
        info: {
            faculty: info[0],
            fieldOfStudy: info[1],
            period: info[4],
            durationInWeeks: parseInt(info[5]),
            transport: info[6],
            insurance: info[7],
            visa: info[8],
            visaPrice: info[9],
            internshipReferenceNumber: info[12],
        },
        place: {
            locationDescription: bodiesTexts[0],
            aboutCity: bodiesTexts[1],
            aboutSurroundings: bodiesTexts[2],
        },
        work: {
            employerDescription: bodiesTexts[3],
            workDescription: bodiesTexts[4],
            salaryDescription: bodiesTexts[5],
            languageRequirements: bodiesTexts[6],
            accomodation: bodiesTexts[7],
        },
        socialLife: {
            iaesteMembers: bodiesTexts[8],
            foreignStudents: bodiesTexts[9],
            sportAndCulture: bodiesTexts[10],
            food: bodiesTexts[11],
        },
        miscellaneous: {
            communicationWithHome: bodiesTexts[12],
            recommendations: bodiesTexts[13],
            dontForget: bodiesTexts[14],
            benefits: bodiesTexts[15],
            localIaesteCooperation: bodiesTexts[16],
            overallExperienceWithIaeste: bodiesTexts[17],
            otherComments: bodiesTexts[21],
        },
        websites: {
            student: bodiesTexts[18],
            employer: bodiesTexts[19],
            other: bodiesTexts[20].split("\n"),
        },
    };
}
export async function getDataDump() {
    console.log("Fetching base categories");
    console.time(TOTAL_TIMER_LABEL);
    const baseCategories = await getBaseCategories();
    const fields = baseCategories.fields;
    const specializations = [];
    // Fetch fields and specializations, make lookup tables for them
    let reviewIdToFieldId = new Map();
    await PromisePool.withConcurrency(MAX_CONCURRENT_REQUESTS)
        .for(fields)
        .process(async (field) => {
        console.time(field.name.en);
        const cache = new Map(); // avoid requesting the url twice
        const fieldReviews = await getReviewEntriesByField(field.id, cache);
        const fieldSpecializations = await getSpecializationsOfField(field.id, cache);
        specializations.push(...fieldSpecializations);
        for (const review of fieldReviews) {
            reviewIdToFieldId.set(review.id, field.id);
        }
        console.timeEnd(field.name.en);
    });
    let specializationNameToId = new Map();
    for (const { id, name } of specializations) {
        specializationNameToId.set(name.en, id);
        specializationNameToId.set(name.cs, id);
    }
    // Now we actually get the data becuase we need to get them by country to get the city name
    const countryCategories = baseCategories.countryCategories;
    const countries = countryCategories.flatMap((category) => category.countries);
    const reviews = [];
    await PromisePool.withConcurrency(MAX_CONCURRENT_COUNTRIES)
        .for(countries)
        .process(async (country) => {
        console.time(country.name.en);
        const countryId = country.id;
        const reviewEntries = await getReviewEntriesByCountry(countryId);
        const reviewData = await PromisePool.withConcurrency(MAX_CONCURRENT_REQUESTS / MAX_CONCURRENT_COUNTRIES)
            .for(reviewEntries)
            .process((entry) => getReviewContent(entry.id).then((content) => ({ entry, content })));
        for (const { entry, content } of reviewData.results) {
            const reviewId = entry.id;
            const fieldId = reviewIdToFieldId.get(reviewId);
            const specializationId = specializationNameToId.get(content.specializationName);
            reviews.push({
                countryId,
                fieldId,
                specializationId,
                city: entry.location,
                ...omit(entry, "location"),
                ...omit(content, "fieldName", "specializationName"),
            });
        }
        console.timeEnd(country.name.en);
    });
    console.timeEnd(TOTAL_TIMER_LABEL);
    return {
        countryCategories,
        fields,
        specializations,
        reviews,
    };
}
