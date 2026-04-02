import { useState, memo, useCallback } from "react";
import {
  ComposableMap,
  Geographies,
  Geography,
} from "react-simple-maps";

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

const COUNTRY_NAMES: Record<string, string> = {
  "004": "Afghanistan", "008": "Albania", "012": "Algeria", "024": "Angola",
  "032": "Argentina", "036": "Australia", "040": "Austria", "050": "Bangladesh",
  "056": "Belgium", "068": "Bolivia", "076": "Brazil", "100": "Bulgaria",
  "104": "Myanmar", "116": "Cambodia", "120": "Cameroon", "124": "Canada",
  "144": "Sri Lanka", "152": "Chile", "156": "China", "170": "Colombia",
  "180": "Congo (DRC)", "188": "Costa Rica", "191": "Croatia", "192": "Cuba",
  "196": "Cyprus", "203": "Czech Republic", "208": "Denmark", "214": "Dominican Republic",
  "218": "Ecuador", "818": "Egypt", "222": "El Salvador", "231": "Ethiopia",
  "233": "Estonia", "246": "Finland", "250": "France", "266": "Gabon",
  "276": "Germany", "288": "Ghana", "300": "Greece", "320": "Guatemala",
  "332": "Haiti", "340": "Honduras", "348": "Hungary", "352": "Iceland",
  "356": "India", "360": "Indonesia", "364": "Iran", "368": "Iraq",
  "372": "Ireland", "376": "Israel", "380": "Italy", "384": "Ivory Coast",
  "388": "Jamaica", "392": "Japan", "400": "Jordan", "398": "Kazakhstan",
  "404": "Kenya", "408": "North Korea", "410": "South Korea", "414": "Kuwait",
  "418": "Laos", "422": "Lebanon", "426": "Lesotho", "430": "Liberia",
  "434": "Libya", "440": "Lithuania", "442": "Luxembourg", "450": "Madagascar",
  "454": "Malawi", "458": "Malaysia", "466": "Mali", "484": "Mexico",
  "496": "Mongolia", "504": "Morocco", "508": "Mozambique", "516": "Namibia",
  "524": "Nepal", "528": "Netherlands", "554": "New Zealand", "558": "Nicaragua",
  "562": "Niger", "566": "Nigeria", "578": "Norway", "586": "Pakistan",
  "591": "Panama", "600": "Paraguay", "604": "Peru", "608": "Philippines",
  "616": "Poland", "620": "Portugal", "634": "Qatar", "642": "Romania",
  "643": "Russia", "646": "Rwanda", "682": "Saudi Arabia", "686": "Senegal",
  "688": "Serbia", "694": "Sierra Leone", "702": "Singapore", "703": "Slovakia",
  "704": "Vietnam", "705": "Slovenia", "706": "Somalia", "710": "South Africa",
  "716": "Zimbabwe", "724": "Spain", "736": "Sudan", "740": "Suriname",
  "752": "Sweden", "756": "Switzerland", "760": "Syria", "764": "Thailand",
  "780": "Trinidad and Tobago", "784": "UAE", "788": "Tunisia", "792": "Turkey",
  "800": "Uganda", "804": "Ukraine", "826": "United Kingdom", "834": "Tanzania",
  "840": "United States", "854": "Burkina Faso", "858": "Uruguay",
  "860": "Uzbekistan", "862": "Venezuela", "887": "Yemen", "894": "Zambia",
};

/** Map GeoJSON numeric ISO codes to 2-letter alpha-2 codes. */
const NUMERIC_TO_ALPHA2: Record<string, string> = {
  "004": "AF", "008": "AL", "012": "DZ", "024": "AO",
  "032": "AR", "036": "AU", "040": "AT", "050": "BD",
  "056": "BE", "068": "BO", "076": "BR", "100": "BG",
  "104": "MM", "116": "KH", "120": "CM", "124": "CA",
  "144": "LK", "152": "CL", "156": "CN", "170": "CO",
  "180": "CD", "188": "CR", "191": "HR", "192": "CU",
  "196": "CY", "203": "CZ", "208": "DK", "214": "DO",
  "218": "EC", "818": "EG", "222": "SV", "231": "ET",
  "233": "EE", "246": "FI", "250": "FR", "266": "GA",
  "276": "DE", "288": "GH", "300": "GR", "320": "GT",
  "332": "HT", "340": "HN", "348": "HU", "352": "IS",
  "356": "IN", "360": "ID", "364": "IR", "368": "IQ",
  "372": "IE", "376": "IL", "380": "IT", "384": "CI",
  "388": "JM", "392": "JP", "400": "JO", "398": "KZ",
  "404": "KE", "408": "KP", "410": "KR", "414": "KW",
  "418": "LA", "422": "LB", "426": "LS", "430": "LR",
  "434": "LY", "440": "LT", "442": "LU", "450": "MG",
  "454": "MW", "458": "MY", "466": "ML", "484": "MX",
  "496": "MN", "504": "MA", "508": "MZ", "516": "NA",
  "524": "NP", "528": "NL", "554": "NZ", "558": "NI",
  "562": "NE", "566": "NG", "578": "NO", "586": "PK",
  "591": "PA", "600": "PY", "604": "PE", "608": "PH",
  "616": "PL", "620": "PT", "634": "QA", "642": "RO",
  "643": "RU", "646": "RW", "682": "SA", "686": "SN",
  "688": "RS", "694": "SL", "702": "SG", "703": "SK",
  "704": "VN", "705": "SI", "706": "SO", "710": "ZA",
  "716": "ZW", "724": "ES", "736": "SD", "740": "SR",
  "752": "SE", "756": "CH", "760": "SY", "764": "TH",
  "780": "TT", "784": "AE", "788": "TN", "792": "TR",
  "800": "UG", "804": "UA", "826": "GB", "834": "TZ",
  "840": "US", "854": "BF", "858": "UY",
  "860": "UZ", "862": "VE", "887": "YE", "894": "ZM",
};

/** Reverse map: alpha-2 → numeric (for matching selectedCountryCode). */
const ALPHA2_TO_NUMERIC: Record<string, string> = Object.fromEntries(
  Object.entries(NUMERIC_TO_ALPHA2).map(([k, v]) => [v, k]),
);

interface WorldMapProps {
  selectedCountry: string | null;
  selectedCountryCode: string | null; // alpha-2 code (e.g. "US")
  onCountrySelect: (name: string, code: string) => void; // code = alpha-2
  onCountryDeselect: () => void;
}

function WorldMapInner({
  selectedCountry,
  selectedCountryCode,
  onCountrySelect,
  onCountryDeselect,
}: WorldMapProps) {
  const [tooltipContent, setTooltipContent] = useState("");
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  // Convert alpha-2 back to numeric for GeoJSON comparison
  const selectedNumeric = selectedCountryCode
    ? ALPHA2_TO_NUMERIC[selectedCountryCode] || ""
    : "";

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCountryClick = useCallback(
    (countryName: string, numericId: string) => {
      const alpha2 = NUMERIC_TO_ALPHA2[numericId] || numericId;
      if (alpha2 === selectedCountryCode) {
        onCountryDeselect();
      } else {
        onCountrySelect(countryName, alpha2);
      }
    },
    [selectedCountryCode, onCountrySelect, onCountryDeselect]
  );

  return (
    <div className="relative w-full h-full" onMouseMove={handleMouseMove}>
      {tooltipContent && (
        <div
          className="fixed z-50 pointer-events-none px-3 py-1.5 rounded-md text-sm font-medium bg-card text-card-foreground border shadow-lg"
          style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 28 }}
        >
          {tooltipContent}
        </div>
      )}

      <ComposableMap
        projection="geoMercator"
        projectionConfig={{ scale: 120, center: [10, 20] }}
        className="w-full h-full"
      >
        <Geographies geography={GEO_URL}>
          {({ geographies }) =>
            geographies.map((geo) => {
              const numericId = geo.id as string;
              const countryName =
                COUNTRY_NAMES[numericId] || geo.properties.name || "Unknown";
              const isSelected = numericId === selectedNumeric;

              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  data-testid={`country-${numericId}`}
                  onClick={() => handleCountryClick(countryName, numericId)}
                  onMouseEnter={() => setTooltipContent(countryName)}
                  onMouseLeave={() => setTooltipContent("")}
                  className="cursor-pointer outline-none transition-colors duration-150"
                  style={{
                    default: {
                      fill: isSelected ? "#FF3621" : "var(--color-muted)",
                      stroke: "var(--color-border)",
                      strokeWidth: 0.5,
                    },
                    hover: {
                      fill: isSelected ? "#FF3621" : "#FF6F61",
                      stroke: "var(--color-foreground)",
                      strokeWidth: 0.75,
                    },
                    pressed: {
                      fill: "#FF3621",
                      stroke: "var(--color-foreground)",
                      strokeWidth: 1,
                    },
                  }}
                />
              );
            })
          }
        </Geographies>
      </ComposableMap>

      {selectedCountry && (
        <div className="absolute bottom-4 left-4 px-4 py-2 rounded-lg bg-[#FF3621] text-white font-semibold text-sm shadow-lg">
          {selectedCountry}
        </div>
      )}
    </div>
  );
}

export const WorldMap = memo(WorldMapInner);
