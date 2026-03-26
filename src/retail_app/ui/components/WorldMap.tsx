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

interface WorldMapProps {
  selectedCountry: string | null;
  selectedCountryCode: string | null;
  onCountrySelect: (name: string, code: string) => void;
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

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCountryClick = useCallback(
    (countryName: string, countryId: string) => {
      if (countryId === selectedCountryCode) {
        onCountryDeselect();
      } else {
        onCountrySelect(countryName, countryId);
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
              const countryId = geo.id as string;
              const countryName =
                COUNTRY_NAMES[countryId] || geo.properties.name || "Unknown";
              const isSelected = countryId === selectedCountryCode;

              return (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  data-testid={`country-${countryId}`}
                  onClick={() => handleCountryClick(countryName, countryId)}
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
