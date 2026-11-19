const CHARACTER_TILES = {
    'stone': 'stone', 'floor': 'floor', 'wall': 'wall', 'trap': 'trap',
    'treasure': 'treasure', 'goblin': 'goblin', 'boss': 'boss', 'light': 'light', 'stairs': 'stairs'
};

function randint(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

class Generator {
    constructor(width, height, max_rooms, min_room_xy, max_room_xy, rooms_overlap, random_connections, random_spurs, tiles, max_skew = 3) {
        this.width = width;
        this.height = height;
        this.max_rooms = max_rooms;
        this.min_room_xy = min_room_xy;
        this.max_room_xy = max_room_xy;
        this.rooms_overlap = rooms_overlap;
        this.random_connections = random_connections;
        this.random_spurs = random_spurs;
        this.tiles = tiles;
        this.max_skew = max_skew;

        this.level = [];
        this.room_list = [];
        this.corridor_list = [];
    }

    gen_room() {
        const w = randint(this.min_room_xy, this.max_room_xy);
        const h = randint(this.min_room_xy, this.max_room_xy);
        const skew = randint(-this.max_skew, this.max_skew);

        const shift_down = (h - 1) * skew;
        let min_x = 1;
        let max_x = this.width - w - 1;

        if (shift_down > 0) {
            max_x -= shift_down;
        } else {
            min_x -= shift_down;
        }

        if (min_x > max_x) {
            min_x = 1;
            max_x = Math.max(1, this.width - w - 1);
        }

        const x = randint(min_x, max_x);
        const y = randint(1, this.height - h - 1);

        return [x, y, w, h, skew];
    }

    room_overlapping(room, room_list) {
        const [x, y, w, h, skew] = room;
        const shift_down = (h - 1) * skew;
        const min_x = x + Math.min(0, shift_down);
        const max_x = x + w - 1 + Math.max(0, shift_down);
        const min_y = y;
        const max_y = y + h - 1;

        for (const [cx, cy, cw, ch, cskew] of room_list) {
            const c_shift = (ch - 1) * cskew;
            const c_min_x = cx + Math.min(0, c_shift);
            const c_max_x = cx + cw - 1 + Math.max(0, c_shift);
            const c_min_y = cy;
            const c_max_y = cy + ch - 1;

            // Проверка пересечения с отступом в 1 клетку (для будущих стен)
            if (min_x < c_max_x + 1 && max_x + 1 > c_min_x &&
                min_y < c_max_y + 1 && max_y + 1 > c_min_y) {
                return true;
            }
        }
        return false;
    }

    get_random_floor_point(room) {
        const [x, y, w, h, skew] = room;
        for (let tries = 0; tries < 20; tries++) {
            const ry = randint(y, y + h - 1);
            const row_skew = (ry - y) * skew;
            const rx = randint(x + row_skew, x + row_skew + w - 1);
            if (this.level[ry] && this.level[ry][rx] === 'floor') {
                return [rx, ry];
            }
        }
        // Fallback: геометрический центр комнаты
        return [x + Math.floor(w / 2) + Math.floor(h / 2) * skew, y + Math.floor(h / 2)];
    }

    corridor_between_points(x1, y1, x2, y2) {
        if (x1 === x2 || y1 === y2) {
            return [[x1, y1], [x2, y2]];
        }
        // Случайный выбор направления изгиба коридора (Г-образный)
        const join = Math.random() < 0.5 ? 'top' : 'bottom';
        return join === 'top'
            ? [[x1, y1], [x1, y2], [x2, y2]]
            : [[x1, y1], [x2, y1], [x2, y2]];
    }

    join_rooms(room_1, room_2) {
        const p1 = this.get_random_floor_point(room_1);
        const p2 = this.get_random_floor_point(room_2);
        this.corridor_list.push(this.corridor_between_points(p1[0], p1[1], p2[0], p2[1]));
    }

    gen_level() {
        // 1. Инициализация пустой карты
        this.level = Array.from({ length: this.height }, () => new Array(this.width).fill('stone'));
        this.room_list = [];
        this.corridor_list = [];
        const max_iters = this.max_rooms * 10;

        // 2. Генерация комнат
        for (let a = 0; a < max_iters; a++) {
            const tmp_room = this.gen_room();
            if (this.rooms_overlap || this.room_list.length === 0 || !this.room_overlapping(tmp_room, this.room_list)) {
                this.room_list.push(tmp_room);
            }
            if (this.room_list.length >= this.max_rooms) break;
        }

        // 3. Соединение комнат
        for (let a = 0; a < this.room_list.length - 1; a++) {
            this.join_rooms(this.room_list[a], this.room_list[a + 1]);
        }
        for (let a = 0; a < this.random_connections; a++) {
            this.join_rooms(
                this.room_list[randint(0, this.room_list.length - 1)],
                this.room_list[randint(0, this.room_list.length - 1)]
            );
        }
        for (let a = 0; a < this.random_spurs; a++) {
            this.join_rooms(
                [randint(2, this.width - 3), randint(2, this.height - 3), 1, 1, 0],
                this.room_list[randint(0, this.room_list.length - 1)]
            );
        }

        // 4. Отрисовка полов комнат (с учетом наклона)
        for (const [x, y, w, h, skew] of this.room_list) {
            for (let c = 0; c < h; c++) {
                const row_skew = c * skew;
                for (let b = 0; b < w; b++) {
                    this.level[y + c][x + row_skew + b] = 'floor';
                }
            }
        }

        // 5. Отрисовка коридоров (УПРОЩЕННАЯ И НАДЕЖНАЯ ВЕРСИЯ)
        for (const corridor of this.corridor_list) {
            for (let i = 0; i < corridor.length - 1; i++) {
                const [cx1, cy1] = corridor[i];
                const [cx2, cy2] = corridor[i + 1];

                const minX = Math.min(cx1, cx2);
                const maxX = Math.max(cx1, cx2);
                const minY = Math.min(cy1, cy2);
                const maxY = Math.max(cy1, cy2);

                for (let y = minY; y <= maxY; y++) {
                    for (let x = minX; x <= maxX; x++) {
                        if (this.level[y][x] === 'stone') {
                            this.level[y][x] = 'floor';
                        }
                    }
                }
            }
        }

        // 6. Генерация стен вокруг пола
        for (let row = 1; row < this.height - 1; row++) {
            for (let col = 1; col < this.width - 1; col++) {
                if (this.level[row][col] === 'floor') {
                    for (let r = row - 1; r <= row + 1; r++) {
                        for (let c = col - 1; c <= col + 1; c++) {
                            if (this.level[r][c] === 'stone') {
                                this.level[r][c] = 'wall';
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Генерирует карту и возвращает её в формате, готовом для многослойной системы.
 * @returns {Object} { base: 2D-массив (stone/floor/wall), objects: 2D-массив (empty) }
 */
function generateDungeonMap(config) {
    const gen = new Generator(
        config.width, config.height, config.max_rooms, config.min_room_xy,
        config.max_room_xy, config.rooms_overlap, config.random_connections,
        config.random_spurs, CHARACTER_TILES, config.max_skew || 3
    );

    gen.gen_level();

    // Создаем пустой слой объектов того же размера
    const objectLayer = Array.from({ length: gen.height }, () => new Array(gen.width).fill('empty'));

    return {
        base: gen.level,
        objects: objectLayer
    };
}