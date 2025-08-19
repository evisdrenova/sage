export const weatherToolSchema = {
    type: "function",
    name: "get_weather",
    description:
        "Get current weather by place name (e.g., 'San Francisco, US') or coordinates.",
    parameters: {
        type: "object",
        properties: {
            place: { type: "string", description: "City or place name" },
            lat: { type: "number", description: "Latitude (if known)" },
            lon: { type: "number", description: "Longitude (if known)" },
            units: {
                type: "string",
                enum: ["metric", "imperial"],
                description: "Units for temperature and wind; default metric",
            },
        },
        additionalProperties: false,
    },
} as const;

// ---- the tool implementation (runs locally) ----
export async function runWeatherTool(args: {
    place?: string;
    lat?: number;
    lon?: number;
    units?: "metric" | "imperial";
}) {
    let { place, lat, lon, units = "metric" } = args ?? {};
    // Resolve coordinates if only place is provided
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
        place = `${geo.results[0].name}${geo.results[0].country ? ", " + geo.results[0].country : ""
            }`;
    }
    if (lat == null || lon == null) {
        return { ok: false, error: "Provide a place or both lat & lon." };
    }

    const tUnit = units === "imperial" ? "fahrenheit" : "celsius";
    const wUnit = units === "imperial" ? "mph" : "kmh";
    const pUnit = units === "imperial" ? "inch" : "mm";
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
    const locName = place ?? `Lat ${lat.toFixed(3)}, Lon ${lon.toFixed(3)}`;
    const t = (v: any) => (v == null ? "n/a" : Math.round(v));

    const summary = `${locName}: ${t(c.temperature_2m)}${units === "imperial" ? "°F" : "°C"
        } (feels ${t(c.apparent_temperature)}${units === "imperial" ? "°F" : "°C"
        }), wind ${c.wind_speed_10m != null
            ? `${Math.round(c.wind_speed_10m)} ${units === "imperial" ? "mph" : "km/h"}`
            : "n/a"
        }, humidity ${c.relative_humidity_2m ?? "n/a"}%.`;

    return {
        ok: true,
        location: { name: locName, lat, lon },
        current: c,
        units,
        summary,
    };
}