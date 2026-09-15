const fs = require("fs");
const crypto = require("crypto");
const { WebUntis } = require("webuntis");

const CONFIG = {
  server: process.env.WEBUNTIS_SERVER || "elgym.webuntis.com",
  school: process.env.WEBUNTIS_SCHOOL || "elgym",
  username: process.env.WEBUNTIS_USERNAME,
  password: process.env.WEBUNTIS_PASSWORD,
  daysPast: Number(process.env.DAYS_PAST || 14),
  daysFuture: Number(process.env.DAYS_FUTURE || 120),
  outputFile: process.env.OUTPUT_FILE || "stundenplan.ics",
  calendarName:
    process.env.CALENDAR_NAME || "WebUntis Stundenplan",
  timezone: "Europe/Vienna"
};

function requireEnvironmentVariable(name, value) {
  if (!value) {
    throw new Error(
      `Die Umgebungsvariable ${name} fehlt. Bitte als GitHub Secret hinterlegen.`
    );
  }
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function parseUntisDate(value) {
  const text = String(value);

  if (!/^\d{8}$/.test(text)) {
    throw new Error(
      `Ungültiges WebUntis-Datum: ${value}`
    );
  }

  return {
    year: Number(text.slice(0, 4)),
    month: Number(text.slice(4, 6)),
    day: Number(text.slice(6, 8))
  };
}

function parseUntisTime(value) {
  const text = String(value).padStart(4, "0");

  return {
    hour: Number(text.slice(0, 2)),
    minute: Number(text.slice(2, 4))
  };
}

function toIcalLocalDateTime(
  untisDate,
  untisTime
) {
  const date = parseUntisDate(untisDate);
  const time = parseUntisTime(untisTime);

  return (
    `${date.year}${pad(date.month)}${pad(date.day)}` +
    `T${pad(time.hour)}${pad(time.minute)}00`
  );
}

function toUtcTimestamp(date = new Date()) {
  return (
    date.getUTCFullYear() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

function escapeIcalText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldIcalLine(line) {
  if (Buffer.byteLength(line, "utf8") <= 73) {
    return line;
  }

  const parts = [];
  let current = "";
  let currentLength = 0;

  for (const character of line) {
    const characterLength =
      Buffer.byteLength(character, "utf8");

    if (
      currentLength + characterLength > 73
    ) {
      parts.push(current);
      current = ` ${character}`;
      currentLength = 1 + characterLength;
    } else {
      current += character;
      currentLength += characterLength;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts.join("\r\n");
}

function addDays(date, days) {
  const result = new Date(date);

  result.setDate(
    result.getDate() + days
  );

  return result;
}

function uniqueNames(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return [
    ...new Set(
      items
        .map(
          (item) =>
            item?.longname ||
            item?.name ||
            item?.displayName ||
            item?.element?.name
        )
        .filter(Boolean)
    )
  ];
}

function getSubjectNames(lesson) {
  return uniqueNames(
    lesson.su || lesson.subjects
  );
}

function getTeacherNames(lesson) {
  return uniqueNames(
    lesson.te || lesson.teachers
  );
}

function getRoomNames(lesson) {
  return uniqueNames(
    lesson.ro || lesson.rooms
  );
}

function getLessonStatusText(lesson) {
  return [
    lesson.code,
    lesson.lessonCode,
    lesson.cellState,
    lesson.substText,
    lesson.info,
    lesson.lstext,
    lesson.lessonText,
    lesson.periodText,
    lesson.periodInfo,
    lesson.activityType,
    lesson.statflags,
    lesson.is?.event ? "event" : "",
    lesson.is?.standard ? "standard" : "",
    lesson.is?.substitution
      ? "substitution"
      : "",
    lesson.is?.roomSubstitution
      ? "roomsubstitution"
      : ""
  ]
    .filter(
      (value) =>
    
