/**
 * Demucs 4-stem 슬롯 (vocals / bass / drums / other)
 */
(function initInstruments() {
  const fourStems = [
    { id: "vocals", label: "Vocals", slotColor: "#f472b6" },
    { id: "bass", label: "Bass", slotColor: "#34d399" },
    { id: "drums", label: "Drums", slotColor: "#fbbf24" },
    { id: "other", label: "Other", slotColor: "#94a3b8" },
  ];

  window.INSTRUMENT_LIST = fourStems;
  window.STEM_INSTRUMENT_LIST = fourStems;
})();
