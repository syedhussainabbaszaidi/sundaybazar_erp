    // Business modules, loaded in this order. Add a new module by creating modules/<name>.js and listing it here.
    'use strict';
    module.exports = [
        require('./accounts'),
        require('./expenses'),
        require('./marketing'),
        require('./hr'),
        require('./ops'),
        require('./tickets'),
        require('./purchasing'),
        require('./stockline'),
        require('./wms'),
        require('./couriers'),
        require('./inbox'),
        require('./abandoned'),
        require('./home'),
    ];
};