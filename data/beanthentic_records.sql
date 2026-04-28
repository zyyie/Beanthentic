-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: localhost
-- Generation Time: Apr 25, 2026 at 09:34 AM
-- Server version: 10.4.28-MariaDB
-- PHP Version: 8.0.28

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `beanthentic_records`
--

-- --------------------------------------------------------

--
-- Table structure for table `affiliations`
--

CREATE TABLE `affiliations` (
  `id` int(11) NOT NULL,
  `farmer_id` int(11) DEFAULT NULL,
  `fa_officer_member` varchar(100) DEFAULT NULL,
  `rsbsa_registered` enum('YES','NO') DEFAULT NULL,
  `ncfrs` varchar(100) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `farmers`
--

CREATE TABLE `farmers` (
  `id` int(11) NOT NULL,
  `no` int(11) DEFAULT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `first_name` varchar(100) DEFAULT NULL,
  `address_barangay` varchar(150) DEFAULT NULL,
  `birthday` date DEFAULT NULL,
  `remarks` text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `farm_info`
--

CREATE TABLE `farm_info` (
  `id` int(11) NOT NULL,
  `farmer_id` int(11) DEFAULT NULL,
  `is_landowner` tinyint(1) DEFAULT 0,
  `is_cloa_holder` tinyint(1) DEFAULT 0,
  `is_leaseholder` tinyint(1) DEFAULT 0,
  `is_seasonal_farm_worker` tinyint(1) DEFAULT 0,
  `is_others` tinyint(1) DEFAULT 0,
  `total_area_planted_ha` decimal(10,4) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `production`
--

CREATE TABLE `production` (
  `id` int(11) NOT NULL,
  `farmer_id` int(11) DEFAULT NULL,
  `liberica_kg` decimal(10,2) DEFAULT 0.00,
  `excelsa_kg` decimal(10,2) DEFAULT 0.00,
  `robusta_kg` decimal(10,2) DEFAULT 0.00
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `tree_counts`
--

CREATE TABLE `tree_counts` (
  `id` int(11) NOT NULL,
  `farmer_id` int(11) DEFAULT NULL,
  `liberica_bearing` int(11) DEFAULT 0,
  `liberica_non_bearing` int(11) DEFAULT 0,
  `excelsa_bearing` int(11) DEFAULT 0,
  `excelsa_non_bearing` int(11) DEFAULT 0,
  `robusta_bearing` int(11) DEFAULT 0,
  `robusta_non_bearing` int(11) DEFAULT 0,
  `total_bearing` int(11) GENERATED ALWAYS AS (`liberica_bearing` + `excelsa_bearing` + `robusta_bearing`) STORED,
  `total_non_bearing` int(11) GENERATED ALWAYS AS (`liberica_non_bearing` + `excelsa_non_bearing` + `robusta_non_bearing`) STORED,
  `total_trees` int(11) GENERATED ALWAYS AS (`liberica_bearing` + `liberica_non_bearing` + `excelsa_bearing` + `excelsa_non_bearing` + `robusta_bearing` + `robusta_non_bearing`) STORED
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `affiliations`
--
ALTER TABLE `affiliations`
  ADD PRIMARY KEY (`id`),
  ADD KEY `farmer_id` (`farmer_id`);

--
-- Indexes for table `farmers`
--
ALTER TABLE `farmers`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `farm_info`
--
ALTER TABLE `farm_info`
  ADD PRIMARY KEY (`id`),
  ADD KEY `farmer_id` (`farmer_id`);

--
-- Indexes for table `production`
--
ALTER TABLE `production`
  ADD PRIMARY KEY (`id`),
  ADD KEY `farmer_id` (`farmer_id`);

--
-- Indexes for table `tree_counts`
--
ALTER TABLE `tree_counts`
  ADD PRIMARY KEY (`id`),
  ADD KEY `farmer_id` (`farmer_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `affiliations`
--
ALTER TABLE `affiliations`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `farmers`
--
ALTER TABLE `farmers`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `farm_info`
--
ALTER TABLE `farm_info`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `production`
--
ALTER TABLE `production`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `tree_counts`
--
ALTER TABLE `tree_counts`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `affiliations`
--
ALTER TABLE `affiliations`
  ADD CONSTRAINT `affiliations_ibfk_1` FOREIGN KEY (`farmer_id`) REFERENCES `farmers` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `farm_info`
--
ALTER TABLE `farm_info`
  ADD CONSTRAINT `farm_info_ibfk_1` FOREIGN KEY (`farmer_id`) REFERENCES `farmers` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `production`
--
ALTER TABLE `production`
  ADD CONSTRAINT `production_ibfk_1` FOREIGN KEY (`farmer_id`) REFERENCES `farmers` (`id`) ON DELETE CASCADE;

--
-- Constraints for table `tree_counts`
--
ALTER TABLE `tree_counts`
  ADD CONSTRAINT `tree_counts_ibfk_1` FOREIGN KEY (`farmer_id`) REFERENCES `farmers` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
