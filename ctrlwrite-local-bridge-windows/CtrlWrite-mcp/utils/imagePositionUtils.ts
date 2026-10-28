export const getPosPercentages = (posStr: string): { x: number, y: number } => {
    let x = 50, y = 50;
    const parts = posStr.trim().split(/\s+/);

    const isVert = (s: string) => ['top', 'bottom'].includes(s);
    const isHorz = (s: string) => ['left', 'right'].includes(s);

    const parseVal = (v: string) => {
        if (v === 'left' || v === 'top') return 0;
        if (v === 'center') return 50;
        if (v === 'right' || v === 'bottom') return 100;
        return parseFloat(v) || 50;
    };

    if (parts.length === 1) {
        if (isVert(parts[0])) { x = 50; y = parseVal(parts[0]); }
        else if (isHorz(parts[0])) { x = parseVal(parts[0]); y = 50; }
        else if (parts[0] === 'center') { x = 50; y = 50; }
        else { x = parseVal(parts[0]); y = 50; }
    } else if (parts.length >= 2) {
        if (isVert(parts[0]) || isHorz(parts[1])) {
            y = parseVal(parts[0]);
            x = parseVal(parts[1]);
        } else {
            x = parseVal(parts[0]);
            y = parseVal(parts[1]);
        }
    }
    return { x, y };
};

export const cyclePosition = (currentPosition: string): string => {
    const sequence = ['center', 'top', 'bottom', 'left', 'right'];
    const idx = sequence.indexOf(currentPosition);
    return sequence[(idx + 1) % sequence.length];
};