const CHARACTER_TILES = {
    'stone': 'stone', 'floor': 'floor', 'wall': 'wall', 'trap': 'trap',
    'treasure': 'treasure', 'goblin': 'goblin', 'boss': 'boss', 'light': 'light', 'stairs': 'stairs'
};

function randint(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

class Generator {
    constructor(width, height, max_rooms, min_room_xy, max_room_xy, rooms_overlap, random_connections, random_spurs, tiles) {
        this.width = width;
        this.height = height;
        this.max_rooms = max_rooms;
        this.min_room_xy = min_room_xy;
        this.max_room_xy = max_room_xy;
        this.rooms_overlap = rooms_overlap;
        this.random_connections = random_connections;
        this.random_spurs = random_spurs;
        this.tiles = tiles;

        this.level = [];
        this.room_list = [];
        this.corridor_list = [];
        this.types_of_rooms = ["tRoom", "mRoom", "trRoom", "bRoom", "sRoom"];
    }

    gen_room() {
        const w = randint(this.min_room_xy, this.max_room_xy);
        const h = randint(this.min_room_xy, this.max_room_xy);
        const x = randint(1, this.width - w - 1);
        const y = randint(1, this.height - h - 1);
        return [x, y, w, h];
    }

    room_overlapping(room, room_list) {
        const [x, y, w, h] = room;
        for (const current_room of room_list) {
            if (x < (current_room[0] + current_room[2]) &&
                current_room[0] < (x + w) &&
                y < (current_room[1] + current_room[3]) &&
                current_room[1] < (y + h)) {
                return true;
            }
        }
        return false;
    }

    corridor_between_points(x1, y1, x2, y2, join_type = 'either') {
        if ((x1 === x2 && y1 === y2) || x1 === x2 || y1 === y2) {
            return [[x1, y1], [x2, y2]];
        } else {
            let join = null;
            const coords = [x1, x2, y1, y2];

            if (join_type === 'either' && (coords.includes(0) || coords.includes(1))) {
                join = 'bottom';
            } else if (join_type === 'either' && (
                [x1, x2].includes(this.width - 1) || [x1, x2].includes(this.width - 2) ||
                [y1, y2].includes(this.height - 1) || [y1, y2].includes(this.height - 2)
            )) {
                join = 'top';
            } else if (join_type === 'either') {
                join = Math.random() < 0.5 ? 'top' : 'bottom';
            } else {
                join = join_type;
            }

            if (join === 'top') {
                return [[x1, y1], [x1, y2], [x2, y2]];
            } else {
                return [[x1, y1], [x2, y1], [x2, y2]];
            }
        }
    }

    join_rooms(room_1, room_2, join_type = 'either') {
        const sorted_room = [room_1, room_2].sort((a, b) => a[0] - b[0]);
        const x1 = sorted_room[0][0], y1 = sorted_room[0][1], w1 = sorted_room[0][2], h1 = sorted_room[0][3];
        const x1_2 = x1 + w1 - 1, y1_2 = y1 + h1 - 1;
        const x2 = sorted_room[1][0], y2 = sorted_room[1][1], w2 = sorted_room[1][2], h2 = sorted_room[1][3];
        const x2_2 = x2 + w2 - 1, y2_2 = y2 + h2 - 1;

        if (x1 < (x2 + w2) && x2 < (x1 + w1)) {
            const jx1 = randint(x2, x1_2), jx2 = jx1;
            const tmp_y = [y1, y2, y1_2, y2_2].sort((a, b) => a - b);
            const jy1 = tmp_y[1] + 1, jy2 = tmp_y[2] - 1;
            this.corridor_list.push(this.corridor_between_points(jx1, jy1, jx2, jy2));
        } else if (y1 < (y2 + h2) && y2 < (y1 + h1)) {
            let jy1 = y2 > y1 ? randint(y2, y1_2) : randint(y1, y2_2);
            const jy2 = jy1;
            const tmp_x = [x1, x2, x1_2, x2_2].sort((a, b) => a - b);
            const jx1 = tmp_x[1] + 1, jx2 = tmp_x[2] - 1;
            this.corridor_list.push(this.corridor_between_points(jx1, jy1, jx2, jy2));
        } else {
            let join = (join_type === 'either') ? (Math.random() < 0.5 ? 'top' : 'bottom') : join_type;
            if (join === 'top') {
                if (y2 > y1) this.corridor_list.push(this.corridor_between_points(x1_2 + 1, randint(y1, y1_2), randint(x2, x2_2), y2 - 1, 'bottom'));
                else this.corridor_list.push(this.corridor_between_points(randint(x1, x1_2), y1 - 1, x2 - 1, randint(y2, y2_2), 'top'));
            } else {
                if (y2 > y1) this.corridor_list.push(this.corridor_between_points(randint(x1, x1_2), y1_2 + 1, x2 - 1, randint(y2, y2_2), 'top'));
                else this.corridor_list.push(this.corridor_between_points(x1_2 + 1, randint(y1, y1_2), randint(x2, x2_2), y2_2 + 1, 'bottom'));
            }
        }
    }

    gen_level() {
        this.level = Array.from({ length: this.height }, () => new Array(this.width).fill('stone'));
        this.room_list = [];
        this.corridor_list = [];
        const max_iters = this.max_rooms * 5;

        for (let a = 0; a < max_iters; a++) {
            let tmp_room = this.gen_room();
            if (this.rooms_overlap || this.room_list.length === 0) {
                this.room_list.push(tmp_room);
            } else {
                tmp_room = this.gen_room();
                if (!this.room_overlapping(tmp_room, this.room_list)) {
                    this.room_list.push(tmp_room);
                }
            }
            if (this.room_list.length >= this.max_rooms) break;
        }

        if (this.max_rooms > 5) {
            const roomTypes = ["tRoom", "mRoom", "trRoom", "bRoom"];
            for (let i = 0; i < this.max_rooms - 5; i++) {
                this.types_of_rooms.push(roomTypes[randint(0, 3)]);
            }
        }

        for (const room of this.room_list) {
            const idx = randint(0, this.types_of_rooms.length - 1);
            room.push(this.types_of_rooms.splice(idx, 1)[0]);
        }

        for (let a = 0; a < this.room_list.length - 1; a++) {
            this.join_rooms(this.room_list[a], this.room_list[a + 1]);
        }
        for (let a = 0; a < this.random_connections; a++) {
            this.join_rooms(this.room_list[randint(0, this.room_list.length - 1)], this.room_list[randint(0, this.room_list.length - 1)]);
        }
        for (let a = 0; a < this.random_spurs; a++) {
            this.join_rooms([randint(2, this.width - 2), randint(2, this.height - 2), 1, 1], this.room_list[randint(0, this.room_list.length - 1)]);
        }

        for (const room of this.room_list) {
            for (let b = 0; b < room[2]; b++) {
                for (let c = 0; c < room[3]; c++) {
                    this.level[room[1] + c][room[0] + b] = 'floor';
                }
            }
        }

        for (const corridor of this.corridor_list) {
            const [x1, y1] = corridor[0], [x2, y2] = corridor[1];
            for (let w = 0; w < Math.abs(x1 - x2) + 1; w++) {
                for (let h = 0; h < Math.abs(y1 - y2) + 1; h++) {
                    this.level[Math.min(y1, y2) + h][Math.min(x1, x2) + w] = 'floor';
                }
            }
            if (corridor.length === 3) {
                const [x3, y3] = corridor[2];
                for (let w = 0; w < Math.abs(x2 - x3) + 1; w++) {
                    for (let h = 0; h < Math.abs(y2 - y3) + 1; h++) {
                        this.level[Math.min(y2, y3) + h][Math.min(x2, x3) + w] = 'floor';
                    }
                }
            }
        }

        for (let row = 1; row < this.height - 1; row++) {
            for (let col = 1; col < this.width - 1; col++) {
                if (this.level[row][col] === 'floor') {
                    const neighbors = [[row-1,col-1],[row-1,col],[row-1,col+1],[row,col-1],[row,col+1],[row+1,col-1],[row+1,col],[row+1,col+1]];
                    for (const [r, c] of neighbors) {
                        if (this.level[r][c] === 'stone') this.level[r][c] = 'wall';
                    }
                }
            }
        }

        for (const room of this.room_list) {
            const type = room[4], x = room[0], y = room[1], w = room[2], h = room[3];
            if (type === 'trRoom') {
                for (let b = 0; b < w; b++) for (let c = 0; c < h; c++) if (randint(1, 10) === 1 && this.level[y + c][x + b] !== 'wall') this.level[y + c][x + b] = 'trap';
            } else if (type === 'tRoom') {
                for (let b = 0; b < w; b++) for (let c = 0; c < h; c++) if (randint(1, 10) === 1 && this.level[y + c][x + b] !== 'wall') this.level[y + c][x + b] = 'treasure';
            } else if (type === 'mRoom') {
                for (let i = 0; i < randint(1, 5); i++) this.level[randint(y + 1, y + h - 1)][randint(x + 1, x + w - 1)] = 'goblin';
            } else if (type === 'bRoom') {
                this.level[y][x] = 'light'; this.level[y + h - 1][x] = 'light';
                this.level[y][x + w - 1] = 'light'; this.level[y + h - 1][x + w - 1] = 'light';
                this.level[y + Math.floor(h / 2)][x + Math.floor(w / 2)] = 'boss';
            } else if (type === 'sRoom') {
                this.level[y + Math.floor(h / 2)][x + Math.floor(w / 2)] = 'stairs';
            }
        }
    }
}

// Экспортируем функцию для использования в index.html
function generateDungeonMap(config) {
    const gen = new Generator(
        config.width, config.height, config.max_rooms, config.min_room_xy,
        config.max_room_xy, config.rooms_overlap, config.random_connections,
        config.random_spurs, CHARACTER_TILES
    );
    gen.gen_level();
    return gen.level; // Возвращаем 2D-массив строк (например, [['stone', 'wall', ...], ...])
}