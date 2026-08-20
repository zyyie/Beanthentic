from config.farmer_registration_complete import is_farmer_registration_complete


def test_current_registration_fields_count_as_complete():
    row = {
        "first_name": "Ana",
        "last_name": "Dela Cruz",
        "municipality": "Lipa City",
        "province": "Batangas",
    }
    assert is_farmer_registration_complete(row) is True


def test_legacy_fields_still_count_as_complete():
    row = {
        "first_name": "Ana",
        "last_name": "Dela Cruz",
        "barangay": "San Jose",
        "farm_size_ha": "1.5",
    }
    assert is_farmer_registration_complete(row) is True
