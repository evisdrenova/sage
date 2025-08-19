import fetch from "node-fetch";

export const tools = [
    {
        type: "function",
        function: {
            name: "get_weather",
            description:
                "Get current weather for a location. Pass either (lat & lon) or a place name. Units: metric or imperial.",
            parameters: {
                type: "object",
                properties: {
                    place: {
                        type: "string",
                        description:
                            "City or place name, e.g. 'San Francisco' or 'Berlin, DE'. Ignored if lat/lon are provided.",
                    },
                    lat: { type: "number", description: "Latitude (e.g. 37.7749)" },
                    lon: { type: "number", description: "Longitude (e.g. -122.4194)" },
                    units: {
                        type: "string",
                        enum: ["metric", "imperial"],
                        description: "Defaults to metric",
                    },
                },
                additionalProperties: false,
            },
        },
    },
];


type Args = { place?: string; lat?: number; lon?: number; units?: "metric" | "imperial" };

export async function get_weather({ place, lat, lon, units = "metric" }: Args) {
    const { tUnit, wUnit, pUnit } =
        units === "imperial"
            ? { tUnit: "fahrenheit", wUnit: "mph", pUnit: "inch" }
            : { tUnit: "celsius", wUnit: "kmh", pUnit: "mm" };

    // Resolve coordinates if only a place name was given
    if ((lat == null || lon == null) && place) {
        const geoURL =
            "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" +
            encodeURIComponent(place);
        const geo = await (await fetch(geoURL)).json();
        if (!geo?.results?.length) {
            return { ok: false, error: `Could not find coordinates for "${place}".` };
        }
        lat = geo.results[0].latitude;
        lon = geo.results[0].longitude;
        place = `${geo.results[0].name}${geo.results[0].country ? ", " + geo.results[0].country : ""}`;
    }

    if (lat == null || lon == null) {
        return {
            ok: false,
            error: "Please provide either a place name or both lat and lon.",
        };
    }

    const fields = [
        "temperature_2m",
        "apparent_temperature",
        "relative_humidity_2m",
        "precipitation",
        "weather_code",
        "cloud_cover",
        "wind_speed_10m",
        "wind_direction_10m",
    ];
    const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=${fields.join(",")}` +
        `&temperature_unit=${tUnit}&windspeed_unit=${wUnit}&precipitation_unit=${pUnit}&timezone=auto`;

    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `Weather API error: ${res.status}` };

    const data = await res.json();
    const c = data?.current || {};
    const loc = {
        name: place || `Lat ${lat.toFixed(3)}, Lon ${lon.toFixed(3)}`,
        latitude: lat,
        longitude: lon,
        timezone: data?.timezone || "auto",
    };

    const out = {
        ok: true,
        location: loc,
        current: {
            time: c.time,
            temperature: c.temperature_2m,
            apparent_temperature: c.apparent_temperature,
            humidity: c.relative_humidity_2m,
            precipitation: c.precipitation,
            weather_code: c.weather_code,
            cloud_cover: c.cloud_cover,
            wind_speed: c.wind_speed_10m,
            wind_direction: c.wind_direction_10m,
            units: { temperature: tUnit, wind_speed: wUnit, precipitation: pUnit },
        },
        summary: summarize(loc.name, c, units),
        raw: data, // keep raw if you want more details
    };

    return out;
}

function summarize(place: string, c: any, units: "metric" | "imperial") {
    const tUnit = units === "imperial" ? "°F" : "°C";
    const wUnit = units === "imperial" ? "mph" : "km/h";
    const temp = c?.temperature_2m != null ? `${Math.round(c.temperature_2m)}${tUnit}` : "n/a";
    const feel =
        c?.apparent_temperature != null ? `${Math.round(c.apparent_temperature)}${tUnit}` : "n/a";
    const wind =
        c?.wind_speed_10m != null ? `${Math.round(c.wind_speed_10m)} ${wUnit}` : "n/a";
    const hum = c?.relative_humidity_2m != null ? `${c.relative_humidity_2m}%` : "n/a";
    return `${place}: ${temp} (feels ${feel}), wind ${wind}, humidity ${hum}.`;
}
